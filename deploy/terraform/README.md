# Infrastructure

Everything Sibyl runs on is defined here in Terraform. DNS for `opensibyl.world` and `opensibyl.pro` stays at Hostinger, managed through the `hostinger/hostinger` provider.

| Stack | What it is | State |
|---|---|---|
| `bootstrap` | The S3 bucket for Terraform state (versioned, encrypted, private) | Live |
| `site` | The website at https://opensibyl.world: private S3 bucket, CloudFront (HTTPS, HTTP/3, security headers), ACM certificate, redirects from `www` and `opensibyl.pro`, DNS, and the GitHub deploy role | Live |
| `email` | Sending as `opensibyl.world` through Amazon SES: domain identity, DKIM, MAIL FROM `mail.opensibyl.world`, SPF, DMARC | Live |
| `app` | The hosted app at https://app.opensibyl.world: EC2 host, data volume with daily snapshots, ECR, deploy role, DNS | **Prepared, not applied** |

## Who applies what

- **Terraform runs from the owner's machine.** It needs AWS credentials and the Hostinger API token, and neither is stored in GitHub. CI only checks formatting and validity (`.github/workflows/terraform.yml`).
- **Deploys run in GitHub Actions.** They assume a short-lived AWS role over OIDC that can do only one job:
  - publishing the site (`site.yml`, environment `website`);
  - building and deploying the app (`app.yml`, environment `app`; manual only).

## Running Terraform

```bash
export AWS_PROFILE=...                              # or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
export TF_VAR_hostinger_api_token=...               # Hostinger → Account → API
cd deploy/terraform/<stack>
terraform init -backend-config="bucket=sibyl-tfstate-<account id>"
terraform plan -out=plan.tfplan                     # read it
terraform apply plan.tfplan
```

State is locked with S3's native lock file, so two applies can't run at once.

## The website

First-time setup, already done:

1. Apply `bootstrap`, which uses local state.
2. Delete Hostinger's parking `A` record on `@` in both zones. The apex becomes an `ALIAS` to CloudFront, and an `A` record on the same name would conflict.
3. Apply `site`.
4. In GitHub, create the environment `website`, restricted to the `main` branch, and add these repository variables from the stack's outputs:
   - `AWS_SITE_DEPLOY_ROLE_ARN`
   - `SITE_BUCKET`
   - `SITE_DISTRIBUTION_ID`

From then on, every push to `main` that touches `apps/site`, `docs` or `README.md` rebuilds and publishes the site, then checks it's live.

- **Rolling back:** revert the commit. The bucket also keeps old versions of every file for 30 days.

## Email

`email` makes `opensibyl.world` a verified SES sender. The account is out of the SES sandbox. The app sends through SES SMTP (`smtp://USER:PASS@email-smtp.eu-central-1.amazonaws.com:587?requireTLS=true`; see docs/configuration.md, "Email"). Two things are set up when the app launches:

- **SMTP credentials:** an IAM user with `ses:SendRawEmail`, whose SMTP password is derived from its key. Store it in `/sibyl/prod/env` as `SIBYL_SMTP_URL`.
- **The sender address:** `SIBYL_SMTP_FROM="Sibyl <no-reply@opensibyl.world>"`.

DMARC is `p=quarantine`, with strict DKIM alignment.

## The app (when it's time)

1. **Settings.** Put them in SSM Parameter Store, never in Git:
   - `/sibyl/prod/env` (SecureString): the production `.env`. It needs:
     - `OPENROUTER_API_KEY` and `SIBYL_OWNER_TOKEN`;
     - `ALLOWED_ORIGINS=https://app.opensibyl.world`;
     - `SIBYL_APP_URL=https://app.opensibyl.world`;
     - `SIBYL_PUBLIC_GATEWAY_URL=https://app.opensibyl.world/gateway`;
     - `LIVEKIT_PUBLIC_URL=wss://rtc.opensibyl.world`, plus `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`;
     - `SIBYL_SMTP_URL` and `SIBYL_SMTP_FROM`;
     - the `SIBYL_BUDGET_*` caps;
     - for hosted mode, `SIBYL_MODE=hosted` and the hosted settings in docs/hosting.md.
   - `/sibyl/prod/livekit-env` (SecureString): `LIVEKIT_KEYS="<key>: <secret>"`.
   - `/sibyl/prod/acme-email` (String): the address Let's Encrypt writes to about certificates.
2. **Infrastructure.** Apply `app`. A `t3.xlarge` in eu-central-1 costs about $140 a month on demand, plus about $8 for storage and $4 for the IP. Wait for cloud-init to finish; Docker should be installed and `/srv/sibyl` mounted.
3. **GitHub.** Create the environment `app` with required reviewers and the `main` branch only, and add these repository variables:
   - `AWS_APP_DEPLOY_ROLE_ARN`
   - `APP_INSTANCE_ID`
4. **Deploy.** Run the **App** workflow and type `deploy`. It:
   - builds the four images and pushes them to ECR, tagged with the commit;
   - sends `deploy/app/deploy.sh` to the host through Systems Manager;
   - on the host, backs up `sibyl.db`, starts the new images and waits for the gateway to be healthy;
   - rolls back to the previous tag if the gateway doesn't come up healthy.

There is no SSH. For a shell on the host, use Session Manager:

```bash
aws ssm start-session --target <instance id>
```
