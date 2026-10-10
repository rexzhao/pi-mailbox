package main

// cleanup.go implements `mailboxd --cleanup`: connect to the running daemon
// and request an orphan-mailbox GC.

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/coder/websocket"
)

func cleanupDaemon(registryPath, token string) int {
	data, err := os.ReadFile(registryPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: no registry at %s: %v\n", registryPath, err)
		return 1
	}
	var reg struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(data, &reg) != nil || reg.Port <= 0 {
		fmt.Fprintf(os.Stderr, "mailboxd: invalid registry at %s\n", registryPath)
		return 1
	}

	ctx, cancel := contextWithTimeout(30 * time.Second)
	defer cancel()

	ws, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d", reg.Port), nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: cannot reach daemon on port %d: %v\n", reg.Port, err)
		return 1
	}
	defer ws.CloseNow()

	req, _ := json.Marshal(CleanupMsg{T: "cleanup", Rid: 1, Token: token})
	if err := ws.Write(ctx, websocket.MessageText, req); err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: send cleanup: %v\n", err)
		return 1
	}

	for {
		msgType, data, err := ws.Read(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "mailboxd: connection closed: %v\n", err)
			return 1
		}
		if msgType != websocket.MessageText {
			continue
		}
		var reply struct {
			T       string `json:"t"`
			Code    string `json:"code"`
			Message string `json:"message"`
			Results []CleanupResult `json:"results"`
		}
		if json.Unmarshal(data, &reply) != nil {
			continue
		}
		switch reply.T {
		case "cleanup":
			for _, r := range reply.Results {
				if r.Error != "" {
					fmt.Printf("  %s: error: %s\n", r.Project, r.Error)
				} else {
					fmt.Printf("  %s: moved %d orphan mailbox(es)\n", r.Project, r.Moved)
				}
			}
			return 0
		case "error":
			fmt.Fprintf(os.Stderr, "mailboxd: cleanup rejected: %s: %s\n", reply.Code, reply.Message)
			return 1
		}
	}
}
