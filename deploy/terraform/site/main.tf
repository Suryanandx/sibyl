# The public website (apps/site): landing page, product pages and docs.
#
#   S3 (private) ── CloudFront (HTTPS, HTTP/2+3, security headers) ── opensibyl.world
#
# www.opensibyl.world redirects to https://opensibyl.world (and any zones in
# var.redirect_domains, none for now). DNS stays at Hostinger; the certificate is ACM (free,
# renews itself). GitHub Actions publishes the site with a short-lived role
# (OIDC), so no AWS keys are stored in GitHub. See README.md in this folder.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws       = { source = "hashicorp/aws", version = "~> 6.0" }
    hostinger = { source = "hostinger/hostinger", version = "~> 0.1.23" }
  }
  backend "s3" {
    key          = "site/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
    # bucket comes from -backend-config (sibyl-tfstate-<account id>), see README.md
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = local.tags }
}

# CloudFront certificates must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags { tags = local.tags }
}

provider "hostinger" {
  api_token = var.hostinger_api_token
}

locals {
  tags        = { Project = "sibyl", ManagedBy = "terraform", Stack = "site" }
  apex        = var.primary_domain
  all_domains = concat([var.primary_domain, "www.${var.primary_domain}"], flatten([for d in var.redirect_domains : [d, "www.${d}"]]))
  zones       = concat([var.primary_domain], var.redirect_domains)
}

data "aws_caller_identity" "current" {}

# ── Bucket (private; only CloudFront can read it) ───────────────────────────

resource "aws_s3_bucket" "site" {
  bucket = "opensibyl-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Versioning keeps the previous upload of every file, so a bad deploy can be rolled back.
resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ── Certificate (ACM, us-east-1), validated through Hostinger DNS ───────────

resource "aws_acm_certificate" "site" {
  provider                  = aws.us_east_1
  domain_name               = local.apex
  subject_alternative_names = [for d in local.all_domains : d if d != local.apex]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
  depends_on = [hostinger_dns_record.caa_amazon]
}

locals {
  # One CNAME per name being validated, written into the zone it belongs to.
  validation = {
    for o in aws_acm_certificate.site.domain_validation_options : o.domain_name => {
      zone  = one([for z in local.zones : z if o.domain_name == z || endswith(o.domain_name, ".${z}")])
      fqdn  = trimsuffix(o.resource_record_name, ".")
      value = trimsuffix(o.resource_record_value, ".")
      type  = o.resource_record_type
    }
  }
}

resource "hostinger_dns_record" "validation" {
  for_each = local.validation
  zone     = each.value.zone
  name     = trimsuffix(each.value.fqdn, ".${each.value.zone}")
  type     = each.value.type
  value    = each.value.value
  ttl      = 300
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for v in local.validation : v.fqdn]
  depends_on              = [hostinger_dns_record.validation]
}

# ── CloudFront ──────────────────────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "opensibyl-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Redirects every other host to the main domain, and serves index.html for folders.
resource "aws_cloudfront_function" "router" {
  name    = "opensibyl-site-router"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = templatefile("${path.module}/router.js", { apex = local.apex })
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "opensibyl.world website"
  aliases             = local.all_domains
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_All"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.router.arn
    }
  }

  # A missing file comes back from a private bucket as 403; show the 404 page instead.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ── DNS at Hostinger ────────────────────────────────────────────────────────
# The zone apex points at CloudFront with an ALIAS record. Hostinger's parking
# A record on "@" must be removed first (README.md, step 2).

resource "hostinger_dns_record" "apex" {
  for_each  = toset(local.zones)
  zone      = each.key
  name      = "@"
  type      = "ALIAS"
  value     = aws_cloudfront_distribution.site.domain_name
  ttl       = 300
  overwrite = true
}

resource "hostinger_dns_record" "www" {
  for_each  = toset(local.zones)
  zone      = each.key
  name      = "www"
  type      = "CNAME"
  value     = aws_cloudfront_distribution.site.domain_name
  ttl       = 300
  overwrite = true
}

# Only these certificate authorities may issue for these domains: Amazon (this
# site) and Let's Encrypt (the app server's reverse proxy, later). The two
# records share a name, so they are written one after the other, and the
# certificate is only requested once Amazon is allowed.
resource "hostinger_dns_record" "caa_amazon" {
  for_each = toset(local.zones)
  zone     = each.key
  name     = "@"
  type     = "CAA"
  value    = "0 issue \"amazon.com\""
  ttl      = 3600
}

resource "hostinger_dns_record" "caa_letsencrypt" {
  for_each   = toset(local.zones)
  zone       = each.key
  name       = "@"
  type       = "CAA"
  value      = "0 issue \"letsencrypt.org\""
  ttl        = 3600
  depends_on = [hostinger_dns_record.caa_amazon]
}

# ── Deploy role for GitHub Actions (OIDC, no stored keys) ───────────────────

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "deploy" {
  name = "sibyl-site-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Only the main branch of this repository, through the "website" environment.
          "token.actions.githubusercontent.com:sub" = [
            "repo:${var.github_repo}:environment:website",
            "repo:${var.github_repo_immutable}:environment:website",
          ]
        }
      }
    }]
  })
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  name = "publish-site"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.site.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.site.arn}/*" },
      { Effect = "Allow", Action = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], Resource = aws_cloudfront_distribution.site.arn }
    ]
  })
}
