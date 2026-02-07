package lima

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/jo824/claude-playground/internal/config"
	"github.com/jo824/claude-playground/internal/provider"
)

const instanceName = "claude-playground"

func init() {
	provider.Register("lima", func() provider.Provider { return New() })
}

// Provider manages a Lima VM for the playground.
type Provider struct{}

// New creates a new Lima provider.
func New() *Provider {
	return &Provider{}
}

func (p *Provider) Up(ctx context.Context, _ *config.Config) error {
	// Check if already running
	st, err := p.Status(ctx)
	if err == nil && st.Running {
		return fmt.Errorf("instance %q is already running", instanceName)
	}

	cmd := exec.CommandContext(ctx, "limactl", "start", instanceName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("limactl start failed: %s: %w", string(out), err)
	}

	return nil
}

func (p *Provider) Down(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "limactl", "stop", instanceName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("limactl stop failed: %s: %w", string(out), err)
	}
	return nil
}

func (p *Provider) Status(ctx context.Context) (*provider.Status, error) {
	cmd := exec.CommandContext(ctx, "limactl", "list", "--json")
	out, err := cmd.Output()
	if err != nil {
		return &provider.Status{Running: false, Provider: "lima"}, nil
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var entry struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Name == instanceName {
			running := entry.Status == "Running"
			return &provider.Status{
				Running:  running,
				Provider: "lima",
				Address:  fmt.Sprintf("lima://%s", instanceName),
				Uptime:   0 * time.Second,
			}, nil
		}
	}

	return &provider.Status{Running: false, Provider: "lima"}, nil
}

func (p *Provider) SSHConfig(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "limactl", "show-ssh", "--format=config", instanceName)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("limactl show-ssh failed: %w", err)
	}
	return string(out), nil
}
