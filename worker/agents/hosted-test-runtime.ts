import { FakeHostedContainer as Transport, FakeHostedAi as Model, hostedTask as task, modelTool } from '../test/hosted-runtime';
export { commandResult, finishTurn, workTurn } from '../test/hosted-runtime';

export const hostedTask = { ...task, provider: { id: 'openai' as const, owner: 'fixture-owner', version: 'fixture-version' } };
export const prepareTurn = () => modelTool('prepare', { decision: 'Update the fixture without dependencies.', sources: ['fixture.txt'], setup: [], checks: [], noTestsReason: 'The fixture has no test suite.' });
export class FakeHostedAi extends Model {
  private prepared = false;
  constructor(private readonly firstTurn = prepareTurn()) { super(); }
  override run() {
    if (!this.prepared) { this.prepared = true; this.calls++; return Promise.resolve(this.firstTurn); }
    return super.run();
  }
}
export class FakeHostedContainer extends Transport {
  override async exec(args: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    if (args.includes('/usr/bin/python3')) {
      this.executions.push(args);
      return { stdout: new Blob([JSON.stringify({ manifests: [], lockfiles: [], instructions: [], omitted: 0 })]).stream(), stderr: new Blob([]).stream(), exitCode: Promise.resolve(0), kill() {} } as unknown as ExecProcess;
    }
    return super.exec(args[0] === '/usr/local/bin/node' ? ['node', ...args.slice(1)] : args, options);
  }
}
