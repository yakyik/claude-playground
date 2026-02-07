package aws

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/jo824/claude-playground/internal/config"
	"github.com/jo824/claude-playground/internal/provider"
)

func init() {
	provider.Register("aws", func() provider.Provider { return New() })
}

// Provider manages AWS infrastructure via Terraform.
type Provider struct {
	tfDir string
}

// New creates a new AWS provider.
func New() *Provider {
	return &Provider{
		tfDir: filepath.Join("providers", "aws"),
	}
}

func (p *Provider) Up(ctx context.Context, _ *config.Config) error {
	if err := p.tfInit(ctx); err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, "terraform", "apply", "-auto-approve")
	cmd.Dir = p.tfDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("terraform apply failed: %s: %w", string(out), err)
	}
	return nil
}

func (p *Provider) Down(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "terraform", "destroy", "-auto-approve")
	cmd.Dir = p.tfDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("terraform destroy failed: %s: %w", string(out), err)
	}
	return nil
}

func (p *Provider) Status(ctx context.Context) (*provider.Status, error) {
	cmd := exec.CommandContext(ctx, "terraform", "output", "-json")
	cmd.Dir = p.tfDir
	out, err := cmd.Output()
	if err != nil {
		return &provider.Status{Running: false, Provider: "aws"}, nil
	}

	var outputs map[string]struct{ Value string `json:"value"` }
	if err := json.Unmarshal(out, &outputs); err != nil {
		return &provider.Status{Running: false, Provider: "aws"}, nil
	}

	ip := ""
	if o, ok := outputs["public_ip"]; ok {
		ip = o.Value
	}

	return &provider.Status{
		Running:  ip != "",
		Provider: "aws",
		Address:  ip,
		Uptime:   0 * time.Second,
	}, nil
}

func (p *Provider) SSHConfig(ctx context.Context) (string, error) {
	st, err := p.Status(ctx)
	if err != nil {
		return "", err
	}
	if !st.Running || st.Address == "" {
		return "", fmt.Errorf("AWS instance is not running")
	}

	return fmt.Sprintf(`Host playground
  HostName %s
  User ubuntu
  StrictHostKeyChecking no
`, st.Address), nil
}

func (p *Provider) tfInit(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "terraform", "init")
	cmd.Dir = p.tfDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("terraform init failed: %s: %w", string(out), err)
	}
	return nil
}
