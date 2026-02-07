package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the top-level playground configuration loaded from YAML.
type Config struct {
	Provider string         `yaml:"provider"`
	Bastion  BastionConfig  `yaml:"bastion"`
	Services []ServiceEntry `yaml:"services"`
}

// BastionConfig holds settings for the bastion MCP server itself.
type BastionConfig struct {
	Image string `yaml:"image"`
	Port  int    `yaml:"port"`
	Auth  string `yaml:"auth"`
}

// ServiceEntry describes a backend service reachable from the bastion.
type ServiceEntry struct {
	Name           string            `yaml:"name"`
	URL            string            `yaml:"url"`
	HealthCheckPath string           `yaml:"healthCheckPath"`
	TimeoutMs      int               `yaml:"timeoutMs"`
	Headers        map[string]string `yaml:"headers"`
}

// Load reads and parses a YAML config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config %s: %w", path, err)
	}

	return &cfg, nil
}

// LoadWithOverlay loads a base config and merges an overlay on top.
func LoadWithOverlay(basePath, overlayPath string) (*Config, error) {
	base, err := loadRaw(basePath)
	if err != nil {
		return nil, err
	}

	overlay, err := loadRaw(overlayPath)
	if err != nil {
		return nil, err
	}

	merged := StrategicMerge(base, overlay)

	// Re-serialize and deserialize to get a typed Config
	out, err := yaml.Marshal(merged)
	if err != nil {
		return nil, fmt.Errorf("re-serializing merged config: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(out, &cfg); err != nil {
		return nil, fmt.Errorf("parsing merged config: %w", err)
	}

	return &cfg, nil
}

func loadRaw(path string) (interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var raw interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	return raw, nil
}
