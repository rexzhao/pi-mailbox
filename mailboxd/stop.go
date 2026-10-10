package main

// stop.go implements `mailboxd --stop`: connect to the running daemon via
// the shutdown protocol and request a graceful shutdown.

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/coder/websocket"
)

// stopDaemon reads the registry, connects to the daemon, sends a shutdown
// request, and waits for the ack. Exit code 0 on success.
func stopDaemon(registryPath, token string) int {
	data, err := os.ReadFile(registryPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: no registry at %s: %v\n", registryPath, err)
		return 1
	}
	var reg struct {
		Port   int  `json:"port"`
		Remote bool `json:"remote"`
	}
	if json.Unmarshal(data, &reg) != nil || reg.Port <= 0 {
		fmt.Fprintf(os.Stderr, "mailboxd: invalid registry at %s\n", registryPath)
		return 1
	}

	ctx, cancel := contextWithTimeout(5 * time.Second)
	defer cancel()

	ws, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d", reg.Port), nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: cannot reach daemon on port %d: %v\n", reg.Port, err)
		return 1
	}
	defer ws.CloseNow()

	// send the shutdown request
	req, _ := json.Marshal(ShutdownMsg{T: "shutdown", Rid: 1, Token: token})
	if err := ws.Write(ctx, websocket.MessageText, req); err != nil {
		fmt.Fprintf(os.Stderr, "mailboxd: send shutdown: %v\n", err)
		return 1
	}

	// wait for the ack (or an error reply)
	for {
		msgType, data, err := ws.Read(ctx)
		if err != nil {
			// connection closed by the daemon during shutdown: success
			fmt.Println("mailboxd: daemon stopped")
			return 0
		}
		if msgType != websocket.MessageText {
			continue
		}
		var reply struct {
			T       string `json:"t"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &reply) != nil {
			continue
		}
		switch reply.T {
		case "shutdown_ack":
			// wait for the daemon to close the connection (graceful cleanup)
			ws.Read(ctx) //nolint:errcheck — connection will close
			fmt.Println("mailboxd: daemon stopped")
			return 0
		case "error":
			fmt.Fprintf(os.Stderr, "mailboxd: shutdown rejected: %s: %s\n", reply.Code, reply.Message)
			return 1
		}
	}
}

var _ = net.JoinHostPort // guard against unused import during refactor
