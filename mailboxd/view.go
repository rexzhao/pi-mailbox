package main

// view.go implements `mailboxd view`: resolve the running daemon's web UI
// address from the registry, print it, optionally open a browser.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"
)

// viewDaemon resolves and prints the web UI address. Returns the process
// exit code.
func viewDaemon(out io.Writer, registryPath, host, token, tokenFile string, openIt, asJSON bool) int {
	if token == "" && tokenFile != "" {
		data, err := os.ReadFile(tokenFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: read --token-file: %v\n", err)
			return 1
		}
		token = firstLine(string(data))
	}

	data, err := os.ReadFile(registryPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: no registry at %s: %v\n", registryPath, err)
		return 1
	}
	var reg registryFile
	if json.Unmarshal(data, &reg) != nil || reg.Port <= 0 {
		fmt.Fprintf(os.Stderr, "mailboxd: invalid registry at %s\n", registryPath)
		return 1
	}
	if host == "" {
		if reg.Remote {
			// the daemon only knows its bind address; the caller must name
			// the host the browser should use
			fmt.Fprintln(os.Stderr, "mailboxd: remote daemon: --host is required (the registry records only the port)")
			return 1
		}
		host = "127.0.0.1"
	}

	healthz, code := probeHealthz(host, reg.Port, token)
	if code != 0 {
		return code
	}

	url := fmt.Sprintf("http://%s:%d/", host, reg.Port)
	if token != "" {
		url += "#t=" + token
	}
	if asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		enc.Encode(map[string]any{
			"url":             url,
			"host":            host,
			"port":            reg.Port,
			"instanceId":      reg.InstanceID,
			"remote":          reg.Remote,
			"protocolVersion": healthz["protocolVersion"],
		})
	} else {
		fmt.Fprintln(out, url)
	}
	if openIt {
		if err := browserOpener(url); err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: open browser: %v (URL above)\n", err)
		}
	}
	return 0
}

// probeHealthz verifies the daemon is reachable and returns its reply.
func probeHealthz(host string, port int, token string) (map[string]any, int) {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://%s:%d/healthz", host, port), nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: %v\n", err)
		return nil, 1
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: cannot reach daemon at %s:%d: %v\n", host, port, err)
		return nil, 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "mailboxd: daemon at %s:%d answered %s (check --token)\n", host, port, resp.Status)
		return nil, 1
	}
	var reply map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&reply); err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: unparsable healthz reply: %v\n", err)
		return nil, 1
	}
	return reply, 0
}

// browserOpener is a var so tests can inject a fake.
var browserOpener = openBrowser

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// the empty title argument is required: without it the first
		// quoted argument would be treated as the window title
		cmd = exec.Command("cmd", "/c", "start", "", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
