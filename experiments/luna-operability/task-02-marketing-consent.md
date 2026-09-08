# Task 02 — explicit marketing consent

Change the existing Hero newsletter signup so a visitor must explicitly consent to marketing before the subscription is executed.

Requirements:

- The Hero signup UI must include a required marketing-consent checkbox named `marketingConsent`.
- Email remains required and must keep the existing validation behavior.
- The route/action binding must read the consent input and carry it into the business capability invocation.
- The business capability must reject attempts without consent before calling the provider.
- Add a durable `marketing-consent` capability policy and keep the existing `valid-email` policy.
- Update the executable binding contract so Nazare can verify that the consent input is actually wired through the route action.
- The Resend provider adapter and outbound contact payload must remain unchanged.
- Keep provider-specific behavior out of the Carcass component.
- Preserve the existing successful `contact-created` runtime evidence semantics.
- Do not bypass or remove Nazare lint rules, tests, policies, evidence, or architectural constraints to make the task pass.

Finish by running the full verification gate and repair any failures:

```sh
npm run lint
npm test
npm run typecheck
npm run build
```
