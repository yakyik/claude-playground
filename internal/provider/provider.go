package provider

import (
	"context"
	"fmt"
	"time"

	"github.com/jo824/claude-playground/internal/config"
)

// Provider defines the interface for infrastructure backends that can
// host the bastion MCP server (Lima VMs, Docker, cloud instances, etc.)
type Provider interface {
	// Up creates and starts the infrastructure.
	Up(ctx context.Context, cfg *config.Config) error

	// Down stops and removes the infrastructure.
	Down(ctx context.Context) error

	// Status returns the current state of the infrastructure.
	Status(ctx context.Context) (*Status, error)

	// SSHConfig returns an SSH config snippet for connecting to the instance.
	// Returns an error for providers that don't support SSH (e.g., Docker).
	SSHConfig(ctx context.Context) (string, error)
}

// Status describes the current state of an infrastructure provider.
type Status struct {
	Running  bool
	Provider string
	Address  string
	Uptime   time.Duration
}

// Get returns a Provider implementation by name.
// Implementations are registered here to avoid import cycles.
func Get(name string) (Provider, error) {
	factory, ok := registry[name]
	if !ok {
		names := make([]string, 0, len(registry))
		for k := range registry {
			names = append(names, k)
		}
		return nil, fmt.Errorf("unknown provider %q (available: %v)", name, names)
	}
	return factory(), nil
}

// FactoryFunc creates a new Provider instance.
type FactoryFunc func() Provider

var registry = map[string]FactoryFunc{}

// Register adds a provider factory to the global registry.
func Register(name string, factory FactoryFunc) {
	registry[name] = factory
}
