package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var downCmd = &cobra.Command{
	Use:   "down",
	Short: "Stop and remove playground infrastructure",
	Long:  "Tears down the bastion infrastructure created by 'up'.",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadCfg()
		if err != nil {
			return err
		}

		p, err := getProvider(cfg)
		if err != nil {
			return err
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Stopping playground with provider %q...\n", cfg.Provider)
		if err := p.Down(cmd.Context()); err != nil {
			return fmt.Errorf("down failed: %w", err)
		}

		fmt.Fprintln(cmd.OutOrStdout(), "Playground stopped.")
		return nil
	},
}
