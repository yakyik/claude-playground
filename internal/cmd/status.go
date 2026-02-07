package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show playground infrastructure status",
	Long:  "Reports the current state of the bastion infrastructure.",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg, err := loadCfg()
		if err != nil {
			return err
		}

		p, err := getProvider(cfg)
		if err != nil {
			return err
		}

		st, err := p.Status(cmd.Context())
		if err != nil {
			return fmt.Errorf("status check failed: %w", err)
		}

		w := cmd.OutOrStdout()
		fmt.Fprintf(w, "Provider: %s\n", st.Provider)
		fmt.Fprintf(w, "Running:  %v\n", st.Running)
		if st.Address != "" {
			fmt.Fprintf(w, "Address:  %s\n", st.Address)
		}
		if st.Running {
			fmt.Fprintf(w, "Uptime:   %s\n", st.Uptime)
		}

		return nil
	},
}
