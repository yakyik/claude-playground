package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	cfgFile      string
	providerName string
)

var rootCmd = &cobra.Command{
	Use:   "playground-ctl",
	Short: "CLI for managing Claude playground infrastructure",
	Long: `playground-ctl manages the infrastructure that hosts the bastion MCP server.

It supports multiple providers (Lima, Docker, AWS, GCP, Kubernetes) and
handles spinning up/down environments, connecting via SSH, and checking status.

Configuration is loaded from YAML files with optional base+overlay merging.`,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default: playground.yaml)")
	rootCmd.PersistentFlags().StringVar(&providerName, "provider", "", "infrastructure provider (lima, docker, aws, gcp, k8s)")

	rootCmd.AddCommand(upCmd)
	rootCmd.AddCommand(downCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(connectCmd)
}

// Execute runs the root command.
func Execute() error {
	if err := rootCmd.Execute(); err != nil {
		return fmt.Errorf("command failed: %w", err)
	}
	return nil
}
