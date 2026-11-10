variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "domain" {
  type    = string
  default = "opensibyl.world"
}

variable "instance_type" {
  description = "t3.xlarge (4 vCPU, 16 GB) runs the app, Slides and a few agent computers; about $140/month on demand in eu-central-1."
  type        = string
  default     = "t3.xlarge"
}

variable "data_volume_gb" {
  type    = number
  default = 50
}

variable "realtime" {
  description = "Open LiveKit's media ports and publish rtc.<domain> (meetings and voice rooms)."
  type        = bool
  default     = true
}

variable "github_repo" {
  type    = string
  default = "Suryanandx/sibyl"
}

variable "hostinger_api_token" {
  description = "Hostinger API token (DNS). Pass with TF_VAR_hostinger_api_token; never commit it."
  type        = string
  sensitive   = true
}

variable "github_repo_immutable" {
  description = "The same repository in GitHub's immutable subject form (owner@id/name@id). The repository issues OIDC tokens with this prefix; see repos/{repo}/actions/oidc/customization/sub."
  type        = string
  default     = "Suryanandx@55799779/sibyl@1451219403"
}
