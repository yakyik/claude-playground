package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	"github.com/jo824/claude-playground/internal/config"
	"github.com/jo824/claude-playground/internal/provider"
)

const projectName = "claude-playground"

func init() {
	provider.Register("docker", func() provider.Provider { return New() })
}

// Provider manages Docker Compose infrastructure for the playground.
type Provider struct{}

// New creates a new Docker provider.
func New() *Provider {
	return &Provider{}
}

func (p *Provider) Up(ctx context.Context, _ *config.Config) error {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", projectName, "up", "-d")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker compose up failed: %s: %w", string(out), err)
	}
	return nil
}

func (p *Provider) Down(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", projectName, "down")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker compose down failed: %s: %w", string(out), err)
	}
	return nil
}

func (p *Provider) Status(ctx context.Context) (*provider.Status, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", projectName, "ps", "--format", "json")
	out, err := cmd.Output()
	if err != nil {
		return &provider.Status{Running: false, Provider: "docker"}, nil
	}

	var containers []struct {
		Name  string `json:"Name"`
		State string `json:"State"`
	}
	if err := json.Unmarshal(out, &containers); err != nil {
		return &provider.Status{
			Running:  len(out) > 0,
			Provider: "docker",
			Address:  "localhost",
		}, nil
	}

	running := false
	for _, c := range containers {
		if c.State == "running" {
			running = true
			break
		}
	}

	return &provider.Status{
		Running:  running,
		Provider: "docker",
		Address:  "localhost",
		Uptime:   0 * time.Second,
	}, nil
}

func (p *Provider) SSHConfig(_ context.Context) (string, error) {
	return "", fmt.Errorf("SSH not supported for Docker provider — use 'docker exec' instead")
}
