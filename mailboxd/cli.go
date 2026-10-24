package main

// cli.go: the `mailboxd binding` management CLI.
//
// A thin client over the daemon's HTTP admin endpoints (/api/binding-*),
// which run the SAME shared ops as the WS protocol — management is
// entry-point agnostic. The daemon is discovered through the registry file
// on every call (local mode ports are ephemeral by design); secrets reach
// the daemon only through the HTTP body, read from files or environment
// variables — never from command-line arguments.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// identity derivation (a faithful port of src/daemon.ts so a CLI run in a
// project directory derives the same project id a session would)
// ---------------------------------------------------------------------------

var hostIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// cliHome mirrors daemonHome(): $PI_MAILBOXD_DIR or ~/.pi.
func cliHome() string {
	if dir := os.Getenv("PI_MAILBOXD_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi")
}

// readHostIDCLI mirrors readHostId(): 16 hex chars in <home>/mailbox-host-id,
// created once (concurrent writers converge via last-write-wins re-read).
func readHostIDCLI() (string, error) {
	path := filepath.Join(cliHome(), "mailbox-host-id")
	read := func() string {
		data, err := os.ReadFile(path)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(data))
	}
	if existing := read(); hostIDRe.MatchString(existing) {
		return existing, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	id := hex.EncodeToString(b)
	if err := os.WriteFile(path, []byte(id+"\n"), 0o644); err != nil {
		// another process created it, or invalid content we cannot fix
		if existing := read(); hostIDRe.MatchString(existing) {
			return existing, nil
		}
		return "", err
	}
	if existing := read(); hostIDRe.MatchString(existing) {
		return existing, nil
	}
	return id, nil
}

// shortHash36 mirrors shortHash(): first `length` base36 chars of the sha256
// of the input, zero-padded.
func shortHash36(input string, length int) string {
	digest := sha256.Sum256([]byte(input))
	n := new(big.Int)
	n.SetString(hex.EncodeToString(digest[:]), 16)
	s := n.Text(36)
	for len(s) < length {
		s = "0" + s
	}
	return s[:length]
}

// deriveProjectIDCLI mirrors deriveProjectId(): deterministic per
// (host id, normalized absolute path).
func deriveProjectIDCLI(dir string) (string, error) {
	hostID, err := readHostIDCLI()
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return shortHash36(hostID+"\n"+filepath.ToSlash(abs), 8), nil
}

// ---------------------------------------------------------------------------
// admin API client
// ---------------------------------------------------------------------------

// adminClient resolves the running daemon from the registry and issues
// admin POSTs (Bearer when a token is configured).
type adminClient struct {
	baseURL string
	token   string
	http    *http.Client
}

func newAdminClient(registryPath, hostFlag, token, tokenFile string) (*adminClient, error) {
	data, err := os.ReadFile(registryPath)
	if err != nil {
		return nil, fmt.Errorf("no running daemon (registry %s unreadable: %v) — start it first", registryPath, err)
	}
	var reg registryFile
	if err := json.Unmarshal(data, &reg); err != nil || reg.Port <= 0 {
		return nil, fmt.Errorf("registry %s is invalid — is the daemon running?", registryPath)
	}
	host := hostFlag
	if host == "" {
		host = "127.0.0.1"
	}
	if token == "" && tokenFile != "" {
		data, err := os.ReadFile(tokenFile)
		if err != nil {
			return nil, fmt.Errorf("read --token-file: %v", err)
		}
		token = firstLine(string(data))
	}
	return &adminClient{
		baseURL: fmt.Sprintf("http://%s:%d", host, reg.Port),
		token:   token,
		http:    &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// post sends one admin request and decodes the JSON reply.
func (c *adminClient) post(path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound && strings.TrimSpace(string(data)) == `{"error":"not found"}` {
		return fmt.Errorf("daemon does not support binding management (old version? update the daemon)")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			return fmt.Errorf("%s: %s", e.Error, e.Message)
		}
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// ---------------------------------------------------------------------------
// config assembly (secrets from files or environment — never from argv)
// ---------------------------------------------------------------------------

// buildBindingConfig assembles the channel config JSON. Sources:
//   - --config-file: the whole channel-defined config (any channel, no CLI
//     channel knowledge)
//   - webhook sugar: --url plus --secret-file or --secret-env (the argv
//     carries only a path / a variable name)
//
// There is deliberately NO flag that takes a secret or header VALUE: values
// must not land in argv, ps output, or shell history.
func buildBindingConfig(configFile, url, secretFile, secretEnv string) (json.RawMessage, error) {
	var cfg map[string]any

	if configFile != "" {
		if url != "" || secretFile != "" || secretEnv != "" {
			return nil, fmt.Errorf("--config-file cannot be combined with --url/--secret-file/--secret-env")
		}
		data, err := os.ReadFile(configFile)
		if err != nil {
			return nil, fmt.Errorf("read --config-file: %v", err)
		}
		if json.Unmarshal(data, &cfg) != nil {
			return nil, fmt.Errorf("--config-file is not valid JSON")
		}
		return data, nil
	}

	if url == "" {
		return nil, fmt.Errorf("a config is required: --config-file <json>, or --url plus a secret source (--secret-file / --secret-env)")
	}
	secret := ""
	switch {
	case secretFile != "" && secretEnv != "":
		return nil, fmt.Errorf("use either --secret-file or --secret-env, not both")
	case secretFile != "":
		data, err := os.ReadFile(secretFile)
		if err != nil {
			return nil, fmt.Errorf("read --secret-file: %v", err)
		}
		secret = strings.TrimSpace(string(data))
	case secretEnv != "":
		secret = strings.TrimSpace(os.Getenv(secretEnv))
	default:
		return nil, fmt.Errorf("the secret must come from a file (--secret-file) or an environment variable (--secret-env); there is no --secret flag by design")
	}
	if secret == "" {
		return nil, fmt.Errorf("the secret source is empty")
	}
	cfg = map[string]any{"url": url, "secret": secret}
	out, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// the binding subcommand
// ---------------------------------------------------------------------------

func runBindingCommand(args []string) int {
	if len(args) == 0 {
		printBindingUsage()
		return 2
	}
	sub := args[0]
	fs := flag.NewFlagSet("binding "+sub, flag.ExitOnError)
	var (
		registry   = fs.String("registry", defaultRegistryPath(), "registry file of the running daemon")
		hostFlag   = fs.String("host", "", "daemon host (remote daemons; local defaults to 127.0.0.1)")
		token      = fs.String("token", "", "connection token (remote-mode daemons)")
		tokenFile  = fs.String("token-file", "", "file containing the connection token (first line)")
		project    = fs.String("project", "", "project id (default: derived from --project-root, like a session in that directory)")
		projectRt  = fs.String("project-root", "", "project root directory (default: the current directory; local-mode daemons need it to locate the store)")
		channel    = fs.String("channel", "webhook", "channel type")
		targetsFl  = fs.String("targets", "", "comma-separated mailbox names in the project")
		configFile = fs.String("config-file", "", "channel config as a JSON file (secrets and custom headers live here)")
		urlFl      = fs.String("url", "", "webhook URL (sugar instead of --config-file)")
		secretFile = fs.String("secret-file", "", "file containing the webhook secret (its VALUE never appears in argv)")
		secretEnv  = fs.String("secret-env", "", "environment VARIABLE holding the webhook secret")
		id         = fs.String("id", "", "binding id (update / delete)")
		enabledFl  = fs.String("enabled", "", "enable or disable (update): on|off")
		force      = fs.Bool("force", false, "take over targets held by offline sessions (user-confirmed)")
	)
	fs.Parse(args[1:])

	if *projectRt == "" {
		cwd, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
			return 1
		}
		*projectRt = cwd
	}
	absRoot, err := filepath.Abs(*projectRt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
		return 1
	}
	*projectRt = absRoot
	if *project == "" {
		derived, err := deriveProjectIDCLI(*projectRt)
		if err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: derive project id: %v\n", err)
			return 1
		}
		*project = derived
	}

	client, err := newAdminClient(*registry, *hostFlag, *token, *tokenFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
		return 1
	}

	splitTargets := func() []string {
		var out []string
		for _, t := range strings.Split(*targetsFl, ",") {
			if t = strings.TrimSpace(t); t != "" {
				out = append(out, t)
			}
		}
		return out
	}

	switch sub {
	case "list":
		var out struct {
			Bindings []bindingInfoView `json:"bindings"`
		}
		if err := client.post("/api/bindings", bindingAdminRequest{Project: *project, ProjectRoot: *projectRt}, &out); err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
			return 1
		}
		if len(out.Bindings) == 0 {
			fmt.Println("no channel bindings in this project")
			return 0
		}
		for _, b := range out.Bindings {
			fmt.Println(renderBindingView(b))
		}
		return 0

	case "add":
		config, err := buildBindingConfig(*configFile, *urlFl, *secretFile, *secretEnv)
		if err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
			return 2
		}
		targets := splitTargets()
		if len(targets) == 0 {
			fmt.Fprintln(os.Stderr, "mailboxd: --targets is required (comma-separated mailbox names)")
			return 2
		}
		var out struct {
			Binding bindingInfoView `json:"binding"`
		}
		if err := client.post("/api/binding-add", bindingAdminRequest{
			Project: *project, ProjectRoot: *projectRt, Channel: *channel,
			Config: config, Targets: targets, Force: *force,
		}, &out); err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
			return 1
		}
		fmt.Printf("binding %s created: %s\n", out.Binding.ID, renderBindingView(out.Binding))
		return 0

	case "update":
		if *id == "" {
			fmt.Fprintln(os.Stderr, "mailboxd: --id is required")
			return 2
		}
		var config json.RawMessage
		if *configFile != "" || *urlFl != "" || *secretFile != "" || *secretEnv != "" {
			config, err = buildBindingConfig(*configFile, *urlFl, *secretFile, *secretEnv)
			if err != nil {
				fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
				return 2
			}
		}
		var enabled *bool
		switch *enabledFl {
		case "":
		case "on":
			v := true
			enabled = &v
		case "off":
			v := false
			enabled = &v
		default:
			fmt.Fprintln(os.Stderr, "mailboxd: --enabled takes 'on' or 'off'")
			return 2
		}
		var targets []string
		if *targetsFl != "" {
			targets = splitTargets()
		}
		var out struct {
			Binding bindingInfoView `json:"binding"`
		}
		if err := client.post("/api/binding-update", bindingAdminRequest{
			Project: *project, ProjectRoot: *projectRt, ID: *id,
			Config: config, Targets: targets, Enabled: enabled, Force: *force,
		}, &out); err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
			return 1
		}
		fmt.Printf("binding %s updated: %s\n", out.Binding.ID, renderBindingView(out.Binding))
		return 0

	case "delete":
		if *id == "" {
			fmt.Fprintln(os.Stderr, "mailboxd: --id is required")
			return 2
		}
		var out struct {
			Binding bindingInfoView `json:"binding"`
		}
		if err := client.post("/api/binding-delete", bindingAdminRequest{
			Project: *project, ProjectRoot: *projectRt, ID: *id,
		}, &out); err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
			return 1
		}
		fmt.Printf("binding %s deleted (targets released)\n", out.Binding.ID)
		return 0

	default:
		fmt.Fprintf(os.Stderr, "mailboxd: unknown binding subcommand %q\n", sub)
		printBindingUsage()
		return 2
	}
}

// renderBindingView prints one redacted binding line (the daemon view
// carries no secrets by construction).
func renderBindingView(b bindingInfoView) string {
	state := "disabled"
	if b.Enabled {
		state = "enabled"
		if len(b.Lost) > 0 {
			state = "enabled, targets lost"
		}
	}
	lost := ""
	if len(b.Lost) > 0 {
		lost = fmt.Sprintf(" [lost: %s]", strings.Join(b.Lost, ", "))
	}
	desc := ""
	if b.Describe != "" {
		desc = " — " + b.Describe
	}
	return fmt.Sprintf("%s %s -> %s%s (%s)%s", b.ID, b.Channel, strings.Join(b.Targets, ", "), lost, state, desc)
}

func printBindingUsage() {
	fmt.Println("mailboxd binding — manage channel bindings over the running daemon's admin API")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  mailboxd binding list   [--project <id>] [flags]")
	fmt.Println("  mailboxd binding add    --project <id> --channel <type> --targets a,b (--config-file cfg.json | --url URL --secret-file s.txt [--secret-env VAR]) [--force]")
	fmt.Println("  mailboxd binding update --project <id> --id <binding> [--config-file cfg.json] [--targets a,b] [--enabled on|off] [--force]")
	fmt.Println("  mailboxd binding delete --project <id> --id <binding>")
	fmt.Println()
	fmt.Println("--project defaults to the id derived from --project-root (default: cwd),")
	fmt.Println("the same derivation a session in that directory uses. Secrets and custom")
	fmt.Println("headers never appear on the command line: pass them via --config-file,")
	fmt.Println("--secret-file, or --secret-env (protect secret files with chmod 600).")
	fmt.Println()
	fmt.Println("Flags:")
	fmt.Println("  --registry <file>   daemon registry file (default ~/.pi/mailboxd.json)")
	fmt.Println("  --host <addr>       daemon host (remote daemons)")
	fmt.Println("  --token <secret>    connection token (remote-mode daemons)")
	fmt.Println("  --token-file <path> file containing the connection token")
	fmt.Println("  --project <id>      project id (default: derived from --project-root)")
	fmt.Println("  --project-root <d>  project root (default: cwd)")
	fmt.Println("  --channel <type>    channel type (default webhook)")
	fmt.Println("  --targets <a,b,...> mailbox names the channel claims")
	fmt.Println("  --config-file <f>   channel config JSON (secrets/headers live here)")
	fmt.Println("  --url <url>         webhook URL (sugar instead of --config-file)")
	fmt.Println("  --secret-file <f>   file holding the webhook secret")
	fmt.Println("  --secret-env <var>  environment variable holding the webhook secret")
	fmt.Println("  --id <binding>      binding id (update / delete)")
	fmt.Println("  --enabled <on|off>  enable or disable (update)")
	fmt.Println("  --force             take over targets held by offline sessions")
}
