variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
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
