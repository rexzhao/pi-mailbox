package main

// Tests for the binding admin API and the CLI's config assembly:
// auth matrix, redaction, shared-rule parity, and the argv discipline
// (secret values never come from command-line arguments).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// derivation parity with the TS implementation (pinned vectors)
// ---------------------------------------------------------------------------

func TestDeriveProjectIDParity(t *testing.T) {
	t.Setenv("PI_MAILBOXD_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(cliHome(), "mailbox-host-id"), []byte("0123456789abcdef\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	vectors := []struct {
		path string
		want string
	}{
		// computed with src/daemon.ts's shortHash (sha256 -> base36 -> 8 chars)
		{"C:\\work\\pi-mailbox", "2birx2am"},
		{"D:\\x\\y", "3v1ascrj"},
	}
	for _, v := range vectors {
		got, err := deriveProjectIDCLI(v.path)
		if err != nil {
			t.Fatal(err)
		}
		if got != v.want {
			t.Fatalf("deriveProjectIDCLI(%q) = %s, want %s (TS parity broken)", v.path, got, v.want)
		}
	}
	// a different host id must change the derivation
	t.Setenv("PI_MAILBOXD_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(cliHome(), "mailbox-host-id"), []byte("fedcba9876543210\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _ := deriveProjectIDCLI("C:\\work\\pi-mailbox"); got == "2birx2am" {
		t.Fatal("host id must feed the derivation")
	}
}

// ---------------------------------------------------------------------------
// config assembly: secrets only from files or environment
// ---------------------------------------------------------------------------

func TestBuildBindingConfig(t *testing.T) {
	dir := t.TempDir()
	secretFile := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("filesecret123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgFile := filepath.Join(dir, "cfg.json")
	if err := os.WriteFile(cfgFile, []byte(`{"url":"https://b.example/h","secret":"cfgsecret","headers":{"X-K":"v"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// from a secret file
	cfg, err := buildBindingConfig("", "https://b.example/h", secretFile, "")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if json.Unmarshal(cfg, &m) != nil || m["secret"] != "filesecret123" || m["url"] != "https://b.example/h" {
		t.Fatalf("secret-file assembly: %s", cfg)
	}

	// from an environment variable
	t.Setenv("CLI_TEST_SECRET", "envsecret123")
	cfg, err = buildBindingConfig("", "https://b.example/h", "", "CLI_TEST_SECRET")
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(cfg, &m) != nil || m["secret"] != "envsecret123" {
		t.Fatalf("secret-env assembly: %s", cfg)
	}

	// whole config from a file (headers live here — there is no --header)
	cfg, err = buildBindingConfig(cfgFile, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cfg), "cfgsecret") || !strings.Contains(string(cfg), "X-K") {
		t.Fatalf("config-file assembly: %s", cfg)
	}

	// the argv discipline: NO way to pass a secret value directly
	_, err = buildBindingConfig("", "https://b.example/h", "", "")
	if err == nil || !strings.Contains(err.Error(), "no --secret flag by design") {
		t.Fatalf("a bare --url must refuse for lack of a secret source: %v", err)
	}
	if _, err := buildBindingConfig("", "https://b.example/h", secretFile, "CLI_TEST_SECRET"); err == nil {
		t.Fatal("both secret sources must be rejected")
	}
	if _, err := buildBindingConfig(cfgFile, "https://b.example/h", "", ""); err == nil {
		t.Fatal("config-file + url must be rejected")
	}
}

// ---------------------------------------------------------------------------
// admin API: auth matrix, redaction, rule parity with the WS protocol
// ---------------------------------------------------------------------------

func apiPost(t *testing.T, url, token string, payload any) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestBindingAdminAPI(t *testing.T) {
	env := setupBindingDaemon(t)
	defer env.stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", env.port)
	root := filepath.Join(env.tmp, "proj")
	mkroot := func() { os.MkdirAll(filepath.Join(root, ".pi"), 0o755) }
	mkroot()

	// bad requests
	if code, _ := apiPost(t, base+"/api/bindings", "", map[string]any{}); code != 400 {
		t.Fatalf("missing project: %d", code)
	}
	if code, _ := apiPost(t, base+"/api/bindings", "", map[string]any{"project": "bad/project"}); code != 400 {
		t.Fatalf("invalid project id: %d", code)
	}

	// add via the admin API (secret in the BODY, never argv); local mode
	// requires the project root to locate the store
	code, out := apiPost(t, base+"/api/binding-add", "", map[string]any{
		"project": "ptest", "projectRoot": root, "channel": "webhook",
		"config":  map[string]any{"url": "https://bot.example/h", "secret": "admintestsecret", "headers": map[string]string{"X-K": "v"}},
		"targets": []string{"admin-box"},
	})
	if code != 200 {
		t.Fatalf("add: %d %v", code, out)
	}
	bid := out["binding"].(map[string]any)["id"].(string)
	// redaction: no secret, no config echo anywhere in the reply
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "admintestsecret") {
		t.Fatalf("secret leaked: %s", raw)
	}

	// list
	code, out = apiPost(t, base+"/api/bindings", "", map[string]any{"project": "ptest", "projectRoot": root})
	if code != 200 || len(out["bindings"].([]any)) != 1 {
		t.Fatalf("list: %d %v", code, out)
	}
	raw, _ = json.Marshal(out)
	if strings.Contains(string(raw), "admintestsecret") {
		t.Fatalf("secret leaked in list: %s", raw)
	}

	// rule parity: an online-held name is refused (same as the protocol)
	online := dialTest(t, env.port)
	defer online.ws.CloseNow()
	if r := online.request(map[string]any{
		"t": "hello", "rid": 1, "project": "ptest", "projectRoot": root,
		"session": "short00001", "origin": "o1", "agent": "t", "as": "held-live",
	}); r["t"] != "welcome" {
		t.Fatalf("holder login: %v", r)
	}
	code, out = apiPost(t, base+"/api/binding-add", "", map[string]any{
		"project": "ptest", "projectRoot": root, "channel": "webhook",
		"config":  map[string]any{"url": "https://bot.example/h", "secret": "admintestsecret"},
		"targets": []string{"held-live"}, "force": true,
	})
	if code != 409 || out["error"] != "mailbox_in_use" {
		t.Fatalf("online holder via API: %d %v", code, out)
	}

	// update (disable) + delete via the API
	code, out = apiPost(t, base+"/api/binding-update", "", map[string]any{
		"project": "ptest", "projectRoot": root, "id": bid, "enabled": false,
	})
	if code != 200 || out["binding"].(map[string]any)["enabled"] != false {
		t.Fatalf("update: %d %v", code, out)
	}
	// unknown binding -> 404; foreign project -> 403 (not_owner)
	if code, _ = apiPost(t, base+"/api/binding-delete", "", map[string]any{"project": "ptest", "projectRoot": root, "id": "bnope00X"}); code != 404 {
		t.Fatalf("not found: %d", code)
	}
	if code, out = apiPost(t, base+"/api/binding-delete", "", map[string]any{"project": "other", "projectRoot": filepath.Join(env.tmp, "other"), "id": bid}); code != 403 || out["error"] != "not_owner" {
		t.Fatalf("not owner: %d %v", code, out)
	}
	if code, _ = apiPost(t, base+"/api/binding-delete", "", map[string]any{"project": "ptest", "projectRoot": root, "id": bid}); code != 200 {
		t.Fatal("delete failed")
	}
	// released: a session claims the mailbox WITHOUT force (rule parity)
	q := dialTest(t, env.port)
	defer q.ws.CloseNow()
	if r := q.request(map[string]any{
		"t": "hello", "rid": 2, "project": "ptest", "projectRoot": root,
		"session": "short00002", "origin": "o2", "agent": "t", "as": "admin-box",
	}); r["t"] != "welcome" {
		t.Fatalf("released target should be claimable: %v", r)
	}

	// method discipline: GET on an admin endpoint is rejected
	if resp, err := http.Get(base + "/api/bindings"); err != nil || resp.StatusCode != 405 {
		t.Fatalf("GET should be 405: %v %v", resp, err)
	}
}

// token matrix: remote-mode daemon — no/wrong token rejected, correct token in
func TestBindingAdminTokenAPI(t *testing.T) {
	tmp := t.TempDir()
	port, stop := bootDaemon(t, tmp, "tok-123", true)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	payload := map[string]any{"project": "ptest"}
	if code, out := apiPost(t, base+"/api/bindings", "", payload); code != 401 {
		t.Fatalf("no token: %d %v", code, out)
	}
	if code, _ := apiPost(t, base+"/api/bindings", "wrong", payload); code != 401 {
		t.Fatal("wrong token should be 401")
	}
	// remote mode needs no projectRoot (central storage)
	code, out := apiPost(t, base+"/api/binding-add", "tok-123", map[string]any{
		"project": "ptest", "channel": "webhook",
		"config":  map[string]any{"url": "https://bot.example/h", "secret": "remotesecret"},
		"targets": []string{"remote-box"},
	})
	if code != 200 {
		t.Fatalf("tokened add: %d %v", code, out)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "remotesecret") {
		t.Fatalf("secret leaked: %s", raw)
	}
	if code, _ := apiPost(t, base+"/api/bindings", "tok-123", payload); code != 200 {
		t.Fatal("tokened list failed")
	}
}
