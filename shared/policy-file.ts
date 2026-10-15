import * as v from 'valibot';
import { DEFAULT_POLICY, REVIEW_APPS, type Policy, type PolicyRule } from './policy';
import { validGlob } from './glob';

const AUTONOMY = v.picklist(['auto', 'review', 'human']);
const whole = (min: number, max: number) => v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));
const filled = (max: number) => v.pipe(v.string(), v.check(value => value.trim() !== ''), v.maxLength(max));
const patterns = v.pipe(v.array(v.pipe(filled(300), v.check(validGlob))), v.maxLength(200));
const record = v.custom<Record<string, unknown>>(value => !!value && typeof value === 'object' && !Array.isArray(value));
const object = <const T extends v.ObjectEntries>(entries: T) => v.pipe(record, v.strictObject(entries));

/**
 * `.braid/policy.json` as a schema in which every field is optional and an
 * invalid field keeps its default for display, reporting why into `errors`.
 * Any error requires a person for every pull request.
 */
function policyFile(errors: string[]) {
  const field = <const S extends v.GenericSchema>(schema: S, fallback: v.InferOutput<S>, error: string) =>
    v.optional(v.fallback(schema, () => { errors.push(error); return structuredClone(fallback); }), fallback);
  const maybe = <const S extends v.GenericSchema>(schema: S, error: string) =>
    v.optional(v.fallback(v.optional(schema), () => { errors.push(error); return undefined; }));
  const autonomy = (label: string, fallback: Policy['autonomy']) => field(AUTONOMY, fallback, `${label} must be "auto", "review" or "human".`);
  const count = (label: string, fallback: number, max: number, min = 0) => field(whole(min, max), fallback, `${label} must be a whole number from ${min} to ${max}.`);
  const commands = maybe(v.pipe(v.array(filled(400)), v.maxLength(10)), 'checks must list up to ten commands.');
  const install = maybe(filled(400), 'install must be one command.');
  const guard = (kind: keyof Policy['guards']) => field(v.picklist(['attention', 'revise', 'off']), DEFAULT_POLICY.guards[kind], `guards.${kind} must be "attention", "revise" or "off".`);
  const rule = (item: unknown, index: number): PolicyRule[] => {
    const label = `rules[${index}]`;
    const parsed = v.safeParse(object({
      paths: v.pipe(patterns, v.minLength(1)),
      autonomy: maybe(AUTONOMY, `${label}.autonomy must be "auto", "review" or "human".`),
      reviewers: maybe(whole(0, 5), `${label}.reviewers must be a whole number from 0 to 5.`),
      protected: field(v.boolean(), false, `${label}.protected must be true or false.`),
      note: maybe(v.pipe(v.string(), v.transform(note => note.slice(0, 300))), `${label}.note must be text.`),
    }), item);
    if (parsed.success) {
      const { protected: guarded, ...rest } = parsed.output;
      return [{ ...rest, ...(guarded ? { protected: true } : {}) }];
    }
    errors.push(!item || typeof item !== 'object' ? `${label} must be an object.` : 'paths' in item ? `${label}.paths must be a list of path patterns.` : `${label}.paths is required.`);
    return [];
  };
  return v.pipe(object({
    version: field(v.literal(1), 1, 'version must be 1.'),
    autonomy: autonomy('autonomy', DEFAULT_POLICY.autonomy),
    reviewers: count('reviewers', DEFAULT_POLICY.reviewers, 5),
    checks: commands,
    install,
    verify: field(object({
      checks: commands,
      install,
      minutes: count('verify.minutes', DEFAULT_POLICY.verify.minutes, 60, 1),
      retries: count('verify.retries', DEFAULT_POLICY.verify.retries, 3),
      parallel: count('verify.parallel', DEFAULT_POLICY.verify.parallel, 10, 1),
      required: field(v.pipe(v.array(v.pipe(v.string(), v.regex(/^[\w./ :-]{1,100}$/))), v.maxLength(10)), [], 'verify.required must list up to ten status names.'),
    }), { minutes: DEFAULT_POLICY.verify.minutes, retries: DEFAULT_POLICY.verify.retries, parallel: DEFAULT_POLICY.verify.parallel, required: [] }, 'verify must be an object.'),
    rules: field(v.pipe(v.array(v.unknown()), v.maxLength(100), v.transform(items => items.flatMap(rule))), DEFAULT_POLICY.rules, 'rules must be a list of up to 100 rules.'),
    merge: field(object({
      union: maybe(patterns, 'merge.union must be a list of path patterns.'),
      json: field(v.boolean(), true, 'merge.json must be true or false.'),
    }), { json: true }, 'merge must be an object.'),
    limits: field(object({
      files: count('limits.files', DEFAULT_POLICY.limits.files, 10_000),
      lines: count('limits.lines', DEFAULT_POLICY.limits.lines, 1_000_000),
      revisions: count('limits.revisions', DEFAULT_POLICY.limits.revisions, 50),
      dailyPerAuthor: count('limits.dailyPerAuthor', DEFAULT_POLICY.limits.dailyPerAuthor, 100_000),
    }), DEFAULT_POLICY.limits, 'limits must be an object.'),
    guards: field(object({ tests: guard('tests'), dependencies: guard('dependencies'), secrets: guard('secrets'), instructions: guard('instructions') }), DEFAULT_POLICY.guards, 'guards must be an object.'),
    trust: field(object({
      newAuthors: autonomy('trust.newAuthors', DEFAULT_POLICY.trust.newAuthors),
      earnedAfter: count('trust.earnedAfter', DEFAULT_POLICY.trust.earnedAfter, 1000),
    }), DEFAULT_POLICY.trust, 'trust must be an object.'),
    delay: field(object({ minutes: count('delay.minutes', DEFAULT_POLICY.delay.minutes, 1440) }), DEFAULT_POLICY.delay, 'delay must be an object.'),
    duplicates: field(v.picklist(['note', 'attention', 'off']), DEFAULT_POLICY.duplicates, 'duplicates must be "note", "attention" or "off".'),
    github: field(object({
      reviewers: field(v.pipe(v.array(v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/), v.transform(name => Object.hasOwn(REVIEW_APPS, name.toLowerCase()) ? REVIEW_APPS[name.toLowerCase()] : name))), v.maxLength(5)),
        DEFAULT_POLICY.github.reviewers, 'github.reviewers must list up to five GitHub logins.'),
      wait: count('github.wait', DEFAULT_POLICY.github.wait, 120),
    }), DEFAULT_POLICY.github, 'github must be an object.'),
    dependencyReview: field(v.picklist(['block', 'warn', 'off']), DEFAULT_POLICY.dependencyReview, 'dependencyReview must be "block", "warn" or "off".'),
  }), v.transform(({ checks, install, verify: { checks: verifyChecks, install: verifyInstall, ...verify }, merge: { union, json }, ...file }): Policy => {
    const command = verifyInstall ?? install;
    return { ...file, checks: verifyChecks ?? checks ?? [], ...(command ? { install: command } : {}), verify, merge: { ...(union ? { union } : {}), ...(json ? {} : { json: false }) } };
  }));
}

/**
 * Reads `.braid/policy.json`. Invalid JSON, a non-object root or any invalid
 * field requires a person, regardless of matching rules or earned trust.
 * Null means absent; undefined means a present file could not be decoded.
 */
export function parsePolicy(text: string | null | undefined): { policy: Policy; errors: string[] } {
  if (text === null) return { policy: DEFAULT_POLICY, errors: [] };
  const failClosed = (policy: Policy): Policy => ({ ...policy, autonomy: 'human', error: 'Pull requests wait for a person until the policy file is fixed.' });
  if (text === undefined) return { policy: failClosed(DEFAULT_POLICY), errors: ['The policy file must be a regular UTF-8 text file of at most 1 MiB.'] };
  const json = v.safeParse(v.pipe(v.string(), v.parseJson(), record), text);
  if (!json.success) return { policy: failClosed(DEFAULT_POLICY), errors: ['The policy file must be a valid JSON object.'] };
  const errors: string[] = [];
  const parsed = v.safeParse(policyFile(errors), json.output);
  if (!parsed.success) return { policy: failClosed(DEFAULT_POLICY), errors: [...errors, 'The policy file contains an unknown or invalid field.'] };
  const policy = parsed.output;
  return { policy: errors.length ? failClosed(policy) : policy, errors };
}
