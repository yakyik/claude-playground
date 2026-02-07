package k8s

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

const namespace = "bastion"

func init() {
	provider.Register("k8s", func() provider.Provider { return New() })
}

// Provider manages Kubernetes resources for the playground.
type Provider struct {
	manifestDir string
}

// New creates a new Kubernetes provider.
func New() *Provider {
	return &Provider{
		manifestDir: filepath.Join("providers", "k8s"),
	}
}

func (p *Provider) Up(ctx context.Context, _ *config.Config) error {
	manifests := []string{"rbac.yaml", "configmap.yaml", "deployment.yaml", "service.yaml"}
	for _, m := range manifests {
		path := filepath.Join(p.manifestDir, m)
		cmd := exec.CommandContext(ctx, "kubectl", "apply", "-f", path)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("kubectl apply %s failed: %s: %w", m, string(out), err)
		}
	}
	return nil
}

func (p *Provider) Down(ctx context.Context) error {
	manifests := []string{"service.yaml", "deployment.yaml", "configmap.yaml", "rbac.yaml"}
	for _, m := range manifests {
		path := filepath.Join(p.manifestDir, m)
		cmd := exec.CommandContext(ctx, "kubectl", "delete", "-f", path, "--ignore-not-found")
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("kubectl delete %s failed: %s: %w", m, string(out), err)
		}
	}
	return nil
}

func (p *Provider) Status(ctx context.Context) (*provider.Status, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "get", "deployment", "bastion-mcp-server",
		"-n", namespace, "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		return &provider.Status{Running: false, Provider: "k8s"}, nil
	}

	var deployment struct {
		Status struct {
			ReadyReplicas int `json:"readyReplicas"`
		} `json:"status"`
	}
	if err := json.Unmarshal(out, &deployment); err != nil {
		return &provider.Status{Running: false, Provider: "k8s"}, nil
	}

	return &provider.Status{
		Running:  deployment.Status.ReadyReplicas > 0,
		Provider: "k8s",
		Address:  fmt.Sprintf("bastion-mcp-server.%s.svc.cluster.local:3001", namespace),
		Uptime:   0 * time.Second,
	}, nil
}

func (p *Provider) SSHConfig(_ context.Context) (string, error) {
	return "", fmt.Errorf("SSH not supported for Kubernetes provider — use 'kubectl exec' instead")
}
