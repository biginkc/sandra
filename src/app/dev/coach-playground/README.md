# Live Coach playground

Run `npm install` if dependencies are not installed, then `npm run dev` from this checkout.
Open **http://localhost:3000/dev/coach-playground**. No login, environment credentials,
coach feature flag, or phone call is required. With `npm run dev -- --port 3106`, use
**http://localhost:3106/dev/coach-playground**.

The floating, foldable stimulus panel sends seller meaningful/filler/interim and rep
final transcripts through the real coach reducer. Edit the seller message for other
scenarios. Automatic recommendations and follow-up requests return synthetic harness
responses after 500 ms. Follow-ups respect the real UI's eligibility/request limits.
Mute, hold, hangup, and keypad controls only update local state.

Collapse/reopen preserves the session; New call reset remounts the whole session,
clearing transcript, navigation, entered values, recommendations, and call controls.
Fold the stimulus panel by clicking its heading to inspect the UI beneath it.

The page sits outside the authenticated dashboard layout. Only its exact path skips
session middleware, allowing the server page's `notFound()` guard to run outside
`NODE_ENV=development`. Production and test environments cannot render the playground.
No production coach components, scripts, recommendations, or flags are modified.
