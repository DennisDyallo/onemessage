/**
 * Provider barrel — import each provider to trigger self-registration.
 *
 * To add a new provider:
 *   1. Create src/providers/yourplatform.ts implementing MessagingProvider
 *   2. Call registerProvider(yourProvider) at module scope
 *   3. Add an import line here
 */

import "./email.ts";
import "./sms.ts";
import "./signal.ts";
// import "./telegram.ts";   // coming soon
// import "./whatsapp.ts";   // coming soon
