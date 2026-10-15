export class DurableObject<Env> { constructor(protected ctx: DurableObjectState, protected env: Env) {} }
export class WorkflowEntrypoint<Env, Params> { constructor(protected ctx: unknown, protected env: Env) {} }
