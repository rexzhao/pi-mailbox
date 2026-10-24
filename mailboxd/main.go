// Package main implements mailboxd: the standalone mailbox daemon for
// pi-mailbox.
//
// One daemon process serves every project that connects to it, isolating
// data per project. Local mode (default) listens on loopback with a random
// port, holds a crash-safe flock for singleton election, and exits after an
// idle period with zero clients. Remote mode (--listen on a non-loopback
// address) serves external connections from other machines, requires token
// authentication, stores all data under --data-dir, and stays up.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/gofrs/flock"
)

const ProtocolVersion = 2

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix("mailboxd: ")

	// subcommand dispatch: mailboxd <command> [flags]
	if len(os.Args) > 1 {
		var commonRegistry, commonToken string
		commonFlags := func(fs *flag.FlagSet) {
			fs.StringVar(&commonRegistry, "registry", defaultRegistryPath(), "registry file recording the daemon address")
			fs.StringVar(&commonToken, "token", "", "connection token (required by remote-mode daemons)")
		}
		switch os.Args[1] {
		case "stop":
			fs := flag.NewFlagSet("stop", flag.ExitOnError)
			commonFlags(fs)
			fs.Parse(os.Args[2:])
			os.Exit(stopDaemon(commonRegistry, commonToken))
		case "view":
			fs := flag.NewFlagSet("view", flag.ExitOnError)
			commonFlags(fs)
			host := fs.String("host", "", "host to use in the URL (required for remote daemons; local defaults to 127.0.0.1)")
			tokenFile := fs.String("token-file", "", "file containing the connection token (first line)")
			openIt := fs.Bool("open", false, "open the URL in the default browser")
			asJSON := fs.Bool("json", false, "print machine-readable JSON instead of the URL")
			fs.Parse(os.Args[2:])
			os.Exit(viewDaemon(os.Stdout, commonRegistry, *host, commonToken, *tokenFile, *openIt, *asJSON))
		case "version":
			fmt.Println("mailboxd", ProtocolVersion)
			return
		case "help":
			printUsage()
			return
		}
	}

	// daemon mode: mailboxd [flags] or mailboxd serve [flags]
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		os.Args = append(os.Args[:1], os.Args[2:]...) // strip "serve"
	}

	var (
		listen    = flag.String("listen", "127.0.0.1:0", "listen address; a non-loopback address enables remote mode (token required, persistent)")
		dataDir   = flag.String("data-dir", "", "remote-mode storage root (default: ~/.pi/mailboxd-data); one subdirectory per project")
		token     = flag.String("token", "", "connection token required by remote mode (or --token-file)")
		tokenFile = flag.String("token-file", "", "file containing the connection token (first line)")
		idleExitS = flag.Float64("idle-exit", 300, "exit after this many seconds with zero connected clients (local mode only; remote mode disables it unless set explicitly)")
		registryF = flag.String("registry", defaultRegistryPath(), "registry file recording the daemon address")
		lockF     = flag.String("lock", defaultLockPath(), "leader lock file")
	)
	flag.Parse()

	// resolve mode
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatalf("invalid --listen %q: %v", *listen, err)
	}
	ip := net.ParseIP(host)
	loopback := ip != nil && ip.IsLoopback()
	remote := !loopback

	// token handling
	authToken := *token
	if authToken == "" && *tokenFile != "" {
		data, err := os.ReadFile(*tokenFile)
		if err != nil {
			log.Fatalf("read --token-file: %v", err)
		}
		authToken = firstLine(string(data))
	}
	if remote && authToken == "" {
		log.Fatalf("remote mode (--listen %s) requires --token or --token-file", *listen)
	}

	idleExitSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "idle-exit" {
			idleExitSet = true
		}
	})
	idleExit := time.Duration(*idleExitS * float64(time.Second))
	if remote && !idleExitSet {
		// remote mode is the rendezvous for other machines: it must not
		// disappear when no local client is connected
		idleExit = 0
	}
	if *dataDir == "" {
		home, _ := os.UserHomeDir()
		*dataDir = filepath.Join(home, ".pi", "mailboxd-data")
	}

	d := &Daemon{
		RegistryPath: *registryF,
		LockPath:     *lockF,
		ListenAddr:   *listen,
		DataDir:      *dataDir,
		AuthToken:    authToken,
		Remote:       remote,
		IdleExit:     idleExit,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := d.Run(ctx); err != nil {
		log.Fatal(err)
	}
}

// piHome resolves the daemon's config directory: ~/.pi by default, or
// $PI_MAILBOXD_DIR when set (used for test isolation and multi-instance
// setups).
func piHome() string {
	if dir := os.Getenv("PI_MAILBOXD_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi")
}

func defaultRegistryPath() string {
	return filepath.Join(piHome(), "mailboxd.json")
}

func defaultLockPath() string {
	return filepath.Join(piHome(), "mailboxd.leader")
}

func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' || s[i] == '\r' {
			return trimSpace(s[:i])
		}
	}
	return trimSpace(s)
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

// Daemon is one mailboxd process.
type Daemon struct {
	RegistryPath string
	LockPath     string
	ListenAddr   string
	DataDir      string
	AuthToken    string
	Remote       bool
	IdleExit     time.Duration

	instanceID string
	host       string // daemon hostname, shown in the web UI
	port       int

	mu        sync.Mutex
	projects  map[string]*Project // by project UUID
	conns     map[*conn]struct{}  // all authenticated connections
	idleSince time.Time           // zero when clients are connected

	// channel bindings (webhook and friends): daemon-level registry plus
	// the live channel instances, one per enabled binding
	bindingsPath     string
	bindings         *BindingRegistry
	channelsMu       sync.Mutex
	channelInstances map[string]ChannelInstance

	flk    *flock.Flock
	cancel context.CancelFunc
}

// Run elects, listens, and serves until the process exits (error, signal, or
// idle timeout).
func (d *Daemon) Run(ctx context.Context) error {
	d.instanceID = newUUID()
	d.host, _ = os.Hostname()
	d.projects = make(map[string]*Project)
	d.conns = make(map[*conn]struct{})
	d.channelInstances = make(map[string]ChannelInstance)

	// singleton election: crash-safe because the OS releases the flock when
	// the process dies
	// the config dir may not exist yet (first run, or a fresh PI_MAILBOXD_DIR)
	if err := os.MkdirAll(filepath.Dir(d.LockPath), 0o755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	d.flk = flock.New(d.LockPath)
	acquired, err := d.flk.TryLock()
	if err != nil {
		return fmt.Errorf("acquire leader lock: %w", err)
	}
	if !acquired {
		// another daemon already leads this machine
		log.Printf("another mailboxd holds the leader lock; exiting")
		return nil
	}

	listener, err := net.Listen("tcp", d.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", d.ListenAddr, err)
	}
	d.port = listener.Addr().(*net.TCPAddr).Port
	log.Printf("listening on %s (mode=%s instance=%s)", listener.Addr(), modeName(d.Remote), d.instanceID)

	if err := writeRegistry(d.RegistryPath, d.port, d.instanceID, d.Remote); err != nil {
		listener.Close()
		d.flk.Unlock()
		return fmt.Errorf("write registry: %w", err)
	}

	// channel bindings: default location beside the registry/lock files
	// (isolated in tests via RegistryPath/LockPath under a temp dir);
	// remote mode keeps them with the project data
	if d.bindingsPath == "" {
		if d.Remote {
			d.bindingsPath = filepath.Join(d.DataDir, "bindings.jsonl")
		} else {
			d.bindingsPath = filepath.Join(filepath.Dir(d.LockPath), "mailboxd-bindings.jsonl")
		}
	}
	d.bindings = NewBindingRegistry(d.bindingsPath)
	if err := d.bindings.Load(); err != nil {
		log.Printf("bindings journal: %v", err)
	}
	d.startChannels()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	d.cancel = cancel

	httpSrv := &http.Server{Handler: d.httpHandler()}
	serveErrCh := make(chan error, 1)
	go func() {
		if err := httpSrv.Serve(listener); err != nil && err != http.ErrServerClosed {
			serveErrCh <- err
			cancel()
		}
	}()
	if d.IdleExit > 0 {
		go d.idleWatcher(ctx, cancel)
	}

	var serveErr error
	select {
	case serveErr = <-serveErrCh:
	case <-ctx.Done():
	}
	log.Printf("shutting down")
	d.stopChannels()
	log.Printf("channels stopped")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 3*time.Second)
	serr := httpSrv.Shutdown(shutdownCtx)
	shutdownCancel()
	log.Printf("http shutdown done (err=%v)", serr)
	d.removeAllConns()
	log.Printf("conns closed")
	if cerr := clearRegistry(d.RegistryPath, d.instanceID); cerr != nil {
		log.Printf("clear registry: %v", cerr)
	}
	log.Printf("registry cleared")
	if err := d.flk.Unlock(); err != nil {
		log.Printf("unlock: %v", err)
	} else {
		log.Printf("shutdown complete")
	}
	return serveErr
}

// shutdown triggers the unified cleanup path (used by the protocol handler).
func (d *Daemon) shutdown() {
	if d.cancel != nil {
		d.cancel()
	}
}

func modeName(remote bool) string {
	if remote {
		return "remote"
	}
	return "local"
}

// idleWatcher triggers shutdown after IdleExit of zero connected clients.
// It cancels the run context so shutdown goes through the unified cleanup
// path (close conns, clear registry, release the lock).
func (d *Daemon) idleWatcher(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.mu.Lock()
			idle := len(d.conns) == 0
			// enabled channel bindings are consumers too: the daemon must
			// not idle-exit while any webhook (or future channel) is armed
			if idle && d.anyEnabledBindings() {
				idle = false
			}
			if idle && d.idleSince.IsZero() {
				d.idleSince = time.Now()
			} else if !idle {
				d.idleSince = time.Time{}
			}
			expired := idle && !d.idleSince.IsZero() && time.Since(d.idleSince) >= d.IdleExit
			d.mu.Unlock()
			if expired {
				log.Printf("idle for %s with no clients; shutting down", d.IdleExit)
				cancel()
				return
			}
		}
	}
}

// registry file ----------------------------------------------------------------

type registryFile struct {
	Port       int    `json:"port"`
	InstanceID string `json:"instanceId"`
	Remote     bool   `json:"remote"`
	PID        int    `json:"pid"`
}

func writeRegistry(path string, port int, instanceID string, remote bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(registryFile{Port: port, InstanceID: instanceID, Remote: remote, PID: os.Getpid()}, "", "  ")
	data = append(data, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// clearRegistry removes the registry entry if it still points at us.
func clearRegistry(path string, instanceID string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var reg registryFile
	if json.Unmarshal(data, &reg) != nil {
		return nil
	}
	if reg.InstanceID != instanceID {
		return nil
	}
	return os.Remove(path)
}

func printUsage() {
	fmt.Println("mailboxd — standalone mailbox daemon for pi-mailbox")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  mailboxd [daemon-flags]       start the daemon (or: mailboxd serve [daemon-flags])")
	fmt.Println("  mailboxd stop [options]       stop the running daemon")
	fmt.Println("  mailboxd view [options]       print the web UI address of the running daemon")
	fmt.Println("  mailboxd version              print the version")
	fmt.Println()
	fmt.Println("Daemon flags:")
	fmt.Println("  --listen <addr>           listen address (default 127.0.0.1:0; non-loopback enables remote mode)")
	fmt.Println("  --data-dir <dir>          remote-mode storage root")
	fmt.Println("  --token <secret>          connection token (remote mode)")
	fmt.Println("  --token-file <path>       file containing the connection token")
	fmt.Println("  --idle-exit <seconds>     exit after this idle period (default 300; 0 disables)")
	fmt.Println("  --registry <file>         registry file path")
	fmt.Println("  --lock <file>             leader lock file path")
	fmt.Println()
	fmt.Println("View options:")
	fmt.Println("  --host <addr>             host for the URL (required for remote daemons)")
	fmt.Println("  --open                    open the URL in the default browser")
	fmt.Println("  --json                    print JSON {url, host, port, instanceId, remote, protocolVersion}")
	fmt.Println("  --token-file <path>       file containing the connection token")
	fmt.Println()
	fmt.Println("Subcommand options (stop / view):")
	fmt.Println("  --registry <file>         registry file path")
	fmt.Println("  --token <secret>          connection token")
}
