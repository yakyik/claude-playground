variable "project" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "machine_type" {
  description = "GCE machine type"
  type        = string
  default     = "e2-micro"
}

variable "tailscale_auth_key" {
  description = "Tailscale auth key for joining the tailnet"
  type        = string
  sensitive   = true
}

variable "bastion_api_key" {
  description = "API key for the bastion MCP server"
  type        = string
  sensitive   = true
}

variable "bastion_image" {
  description = "Docker image for the bastion MCP server"
  type        = string
  default     = "bastion-mcp-server:latest"
}
