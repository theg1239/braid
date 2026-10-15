import assert from 'node:assert/strict';

// Browser regressions run by .cloudflare/tools/w7-account-verify.mjs against the account mock.
export async function assertMembershipHistory(page, actors) {
  await page.getByRole('button', { name: 'Membership history', exact: true }).click();
  await page.locator('.audit__who').first().waitFor();
  assert.deepEqual(await page.locator('.audit__who').allTextContents(), actors);
  assert.ok(!(await page.locator('.audit').innerText()).includes('A former member'));
  assert.ok(await page.locator('.audit__row').evaluateAll(rows => rows.every(row => {
    const text = row.querySelector('.audit__text').getBoundingClientRect();
    const time = row.querySelector('time').getBoundingClientRect();
    return time.left - text.right >= 8;
  })), 'History timestamps must be separated from the actor and action');
}

export async function assertSearchFocus(page) {
  const trigger = page.getByRole('button', { name: 'Search', exact: true });
  for (const open of ['Enter', 'click']) {
    await trigger.focus();
    if (open === 'Enter') await page.keyboard.press('Enter');
    else await trigger.click();
    await page.getByPlaceholder('Search or jump to…').waitFor();
    await page.keyboard.press('Escape');
    await page.getByPlaceholder('Search or jump to…').waitFor({ state: 'hidden' });
    // Check after the close transition, including the second open of the lazy menu.
    await page.waitForTimeout(300);
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true, `Search must restore its trigger after ${open}`);
  }
}

export async function assertOrganizationTabs(page) {
  const nav = page.getByRole('navigation', { name: 'Organization', exact: true });
  const links = nav.getByRole('link');
  assert.equal(await links.count(), 5);
  for (const link of await links.all()) {
    await link.focus();
    const visible = await link.evaluate(element => {
      const tab = element.getBoundingClientRect(), strip = element.parentElement.getBoundingClientRect();
      return tab.left >= strip.left - 1 && tab.right <= strip.right + 1 && tab.right <= innerWidth;
    });
    assert.ok(visible, `The focused ${await link.innerText()} tab must be fully visible`);
  }
}

export async function assertInbox(page) {
  const inbox = page.getByRole('link', { name: /^Inbox:/ });
  await inbox.waitFor();
  assert.ok(await inbox.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.checkVisibility() && box.width <= 80 && box.left >= 0 && box.right <= innerWidth && box.top >= 0;
  }), 'The compact inbox must be visible without opening a menu');
  assert.ok(Number(await inbox.locator('.global-head__count').innerText()) > 0);
}

export async function assertFlatButton(button) {
  assert.deepEqual(await button.evaluate(element => [element, ...element.querySelectorAll('*')].flatMap(node => {
    if (!node.checkVisibility()) return [];
    return ['', '::before', '::after'].filter(pseudo => getComputedStyle(node, pseudo || null).backgroundImage.includes('gradient'));
  })), [], 'Primary controls and their emphasis layers must be flat');
}

export async function assertEmailConfirmation(page, base, next) {
  await page.goto(`${base}/mock/signin?stale=1&next=${encodeURIComponent(next)}`);
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  await confirm.waitFor();
  await assertFlatButton(confirm);
  await confirm.click();
  await page.getByRole('heading', { name: 'Confirm it’s you', exact: true }).waitFor();
  const url = new URL(page.url());
  assert.equal(url.pathname, '/signin');
  assert.equal(url.searchParams.get('confirm'), '1');
  assert.equal(url.searchParams.get('next'), next);
  assert.equal(await page.getByRole('link', { name: 'Continue with GitHub' }).count(), 0);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('qa-owner@example.test');
  await page.getByRole('button', { name: 'Email me a code', exact: true }).click();
  await page.getByRole('textbox', { name: 'Sign-in code', exact: true }).fill('ABCD2345');
  await assertFlatButton(page.getByRole('button', { name: 'Sign in', exact: true }));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(base + next);
  await page.getByRole('button', { name: 'Add passkey', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Confirm', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).waitFor();
  assert.equal(page.url(), base + next);
}
