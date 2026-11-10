variable "region" {
  description = "Region for the bucket and the deploy role."
  type        = string
  default     = "eu-central-1"
}

variable "primary_domain" {
  description = "The site's address. Everything else redirects here."
  type        = string
  default     = "opensibyl.world"
}

variable "redirect_domains" {
  description = "Other zones at Hostinger whose apex and www redirect to the primary domain (none for now)."
  type        = list(string)
  default     = []
}

variable "github_repo" {
  description = "owner/name of the repository whose Actions may publish the site."
  type        = string
  default     = "Suryanandx/sibyl"
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
