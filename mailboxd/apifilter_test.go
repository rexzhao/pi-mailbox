package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestAPISessionsProjectFilter pins the /api/sessions scoping: the project
// parameter (with projectRoot) both triggers the on-demand load AND scopes
// the response to that project; without it the response spans all projects
// (the web UI, aggregation); a load failure leaves the response unscoped
// rather than silently empty.
func TestAPISessionsProjectFilter(t *testing.T) {
	tmp := t.TempDir()
	root1 := filepath.Join(tmp, "one")
	root2 := filepath.Join(tmp, "two")
	for _, root := range []string{root1, root2} {
		os.MkdirAll(filepath.Join(root, ".pi", "mailbox"), 0o755)
	}
	port, stop := bootDaemon(t, tmp, "", false)
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	// two projects, one session each (via named logins)
	a := dialTest(t, port)
	a.helloNamed(1, "proj-one", root1, "s1", "o1", "one-a", "agent-a", nil)
	b := dialTest(t, port)
	b.helloNamed(1, "proj-two", root2, "s2", "o2", "two-b", "agent-b", nil)

	get := func(q string) []string {
		resp, err := http.Get(base + "/api/sessions?includeOffline=1" + q)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var sb struct {
			Sessions []struct {
				Session string `json:"session"`
				Project string `json:"project"`
			} `json:"sessions"`
		}
		json.NewDecoder(resp.Body).Decode(&sb)
		var out []string
		for _, s := range sb.Sessions {
			out = append(out, s.Project+"/"+s.Session)
		}
		return out
	}

	// no project parameter: all projects
	all := get("")
	if len(all) != 2 {
		t.Fatalf("no-param response must span all projects, got %v", all)
	}

	// project parameter scopes the response (and is what the extension
	// passes: id + root of ITS project)
	one := get("&project=proj-one&projectRoot=" + root1)
	if len(one) != 1 || one[0] != "proj-one/one-a" {
		t.Fatalf("project-scoped response must contain only proj-one, got %v", one)
	}
	two := get("&project=proj-two&projectRoot=" + root2)
	if len(two) != 1 || two[0] != "proj-two/two-b" {
		t.Fatalf("project-scoped response must contain only proj-two, got %v", two)
	}

	// a failed load must not silently scope to empty: the filter is only
	// set when d.project succeeded. (An in-memory project ignores a bogus
	// root entirely, and a nonexistent-but-absolute root is CREATED by
	// NewStore's MkdirAll — so the genuine failure needs a fresh project
	// id with a non-absolute root.)
	unscoped := get("&project=proj-fresh&projectRoot=relative/root")
	if len(unscoped) != 2 {
		t.Fatalf("failed load must leave the response unscoped, got %v", unscoped)
	}

	// "project means what it says" for KNOWN projects: scoping does not
	// require projectRoot (the root only matters for the on-demand load)
	noRoot := get("&project=proj-one")
	if len(noRoot) != 1 || noRoot[0] != "proj-one/one-a" {
		t.Fatalf("known project without root must scope, got %v", noRoot)
	}
	// an UNKNOWN project id without a root: nothing to load, nothing
	// known — unscoped (never "no sessions")
	unknown := get("&project=proj-ghost")
	if len(unknown) != 2 {
		t.Fatalf("unknown project must leave the response unscoped, got %v", unknown)
	}
}
