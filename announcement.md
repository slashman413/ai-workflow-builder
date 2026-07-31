# Release Announcement

**AI Workflow Builder – Production Deployment**

We are excited to announce that the AI Workflow Builder service is now live in production.

## Highlights
- **CI/CD Pipeline**: Automated build, test, containerization, and Kubernetes deployment via GitHub Actions.
- **Monitoring**: Prometheus alerts for high error rate and high latency are now active.
- **Availability**: Service is reachable at `https://ai-workflow.example.com` with an initial SLA of 99.95%.

## What to Expect
- The service will handle workflow orchestration for AI tasks with robust scaling.
- Our SLOs monitor availability and latency; alerts will trigger if error rate exceeds 5% or 99th‑percentile latency exceeds 300 ms.

## Next Steps
- Engineering teams can start integrating with the new endpoint.
- Please report any issues through the incident channel.

Thank you for your support!
