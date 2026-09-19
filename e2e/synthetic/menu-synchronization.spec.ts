import { expect, test } from "@playwright/test";
import { clickMenuItemByTestId } from "../menu-helpers";

test("opening a menu waits for its item instead of repeating the trigger", async ({ page }) => {
  await page.setContent(`<button data-testid="trigger">Triage</button><output id="count">0</output>
    <script>
      let count = 0;
      document.querySelector('button').onclick = () => {
        document.querySelector('#count').textContent = ++count;
        setTimeout(() => {
          if (document.querySelector('[data-testid=item]')) return;
          const item = document.createElement('button');
          item.dataset.testid = 'item'; item.textContent = 'Create lead';
          item.onclick = () => item.textContent = 'Selected';
          document.body.append(item);
        }, 200);
      };
    </script>`);
  await clickMenuItemByTestId(page, "trigger", "item");
  await expect(page.getByTestId("item")).toHaveText("Selected");
  await expect(page.locator("#count")).toHaveText("1");
});
