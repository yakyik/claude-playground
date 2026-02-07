package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/jo824/claude-playground/internal/config"
	"github.com/jo824/claude-playground/internal/provider"
)

var upCmd = &cobra.Command{
	Use:   "up",
	Short: "Create and start playground infrastructure",
	Long:  "Provisions and starts the bastion infrastructure using the configured provider.",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadCfg()
		if err != nil {
			return err
		}

		p, err := getProvider(cfg)
		if err != nil {
			return err
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Starting playground with provider %q...\n", cfg.Provider)
		if err := p.Up(cmd.Context(), cfg); err != nil {
			return fmt.Errorf("up failed: %w", err)
		}

		fmt.Fprintln(cmd.OutOrStdout(), "Playground is running.")
		return nil
	},
}

func loadCfg() (*config.Config, error) {
	if cfgFile != "" {
		return config.Load(cfgFile)
	}
	// Default: look for playground.yaml in current directory
	return config.Load("playground.yaml")
}

func getProvider(cfg *config.Config) (provider.Provider, error) {
	name := providerName
	if name == "" {
		name = cfg.Provider
	}
	if name == "" {
		return nil, fmt.Errorf("no provider specified — use --provider or set provider in config")
	}

	return provider.Get(name)
}
