import { describe, it, expect, vi } from 'vitest';
import piAsk, {
  isRpcMode,
  extractToolNames,
  findPiWebOverlaps,
  buildSteeringNote,
  redirectTwin,
  OWN_PI_WEB_TOOLS,
} from '../../.pi/extensions/pi-ask.ts';

describe('isRpcMode', () => {
  it('detects `--mode rpc`', () => {
    expect(isRpcMode(['pi', '--mode', 'rpc'])).toBe(true);
  });

  it('detects `--mode=rpc`', () => {
    expect(isRpcMode(['pi', '--mode=rpc'])).toBe(true);
  });

  it('is false for interactive (no mode flag)', () => {
    expect(isRpcMode(['pi'])).toBe(false);
  });

  it('is false for other modes', () => {
    expect(isRpcMode(['pi', '--mode', 'json'])).toBe(false);
    expect(isRpcMode(['pi', '-p'])).toBe(false);
  });

  it('does not treat an `rpc` value of an unrelated flag as rpc mode', () => {
    expect(isRpcMode(['pi', '--name', 'rpc'])).toBe(false);
  });
});

describe('structured question tool', () => {
  const questions = [{ question: 'Proceed?', options: [{ label: 'Yes', default: true }, { label: 'No' }] }];

  function execute(input: unknown) {
    const registerTool = vi.fn();
    const argv = process.argv;
    try {
      process.argv = ['pi', '--mode', 'rpc'];
      piAsk({ registerTool, on: vi.fn() } as unknown as Parameters<typeof piAsk>[0]);
    } finally {
      process.argv = argv;
    }
    const tool = registerTool.mock.calls[0][0];
    return tool.execute('id', { questions }, undefined, undefined, { ui: { input } });
  }

  it('waits for the user even when a default is selected', async () => {
    let submit!: (response: string) => void;
    const input = vi.fn((_title: string, _payload: string) => new Promise<string>((resolve) => { submit = resolve; }));
    const pending = execute(input);
    const settled = vi.fn();
    void pending.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(JSON.parse(input.mock.calls[0][1])).toEqual(questions);
    submit('[["No"]]');
    expect((await pending).details).toEqual({ questionCount: 1, answers: { 'Proceed?': ['No'] } });
  });

  it.each([
    ['timedOut', { timedOut: true, cancelled: false }],
    [undefined, { timedOut: false, cancelled: true }],
  ])('never submits the default for outcome %s', async (response, outcome) => {
    const result = await execute(vi.fn(async () => response));
    expect(result.details).toEqual({ questionCount: 1, ...outcome });
    expect(result.content[0].text).toContain('wait for a user message');
  });
});

describe('extractToolNames', () => {
  it('reads an array of name strings', () => {
    expect(extractToolNames(['bash', 'ask_user_question'])).toEqual([
      'bash',
      'ask_user_question',
    ]);
  });

  it('reads tool-definition objects (name/toolName/id)', () => {
    expect(
      extractToolNames([{ name: 'bash' }, { toolName: 'read' }, { id: 'write' }]),
    ).toEqual(['bash', 'read', 'write']);
  });

  it('returns [] for non-arrays', () => {
    expect(extractToolNames(undefined)).toEqual([]);
    expect(extractToolNames(null)).toEqual([]);
    expect(extractToolNames('bash')).toEqual([]);
  });
});

describe('findPiWebOverlaps', () => {
  it('finds bare names whose pi_web_ twin is also active', () => {
    const overlaps = findPiWebOverlaps([
      'ask_user_question',
      'pi_web_ask_user_question',
      'bash',
    ]);
    expect(overlaps).toEqual(['ask_user_question']);
  });

  it('treats our own registered tools as twins even if not in the active list', () => {
    // ghoseb's bare tool active, but pi_web twin only known via OWN_PI_WEB_TOOLS
    expect(findPiWebOverlaps(['ask_user_question'])).toEqual([
      'ask_user_question',
    ]);
    expect(OWN_PI_WEB_TOOLS).toContain('pi_web_ask_user_question');
  });

  it('returns [] when there is no overlap', () => {
    expect(findPiWebOverlaps(['bash', 'read', 'pi_web_set_tab_title'])).toEqual([]);
  });
});

describe('buildSteeringNote', () => {
  it('names the affected tools and directs to the prefixed twin', () => {
    const note = buildSteeringNote(['ask_user_question']);
    expect(note).toContain('"ask_user_question" -> "pi_web_ask_user_question"');
    expect(note).toContain('not supported');
  });
});

describe('redirectTwin', () => {
  const tools = new Set(['pi_web_ask_user_question']);

  it('redirects a bare call whose twin is registered', () => {
    expect(redirectTwin('ask_user_question', tools)).toBe('pi_web_ask_user_question');
  });

  it('does not redirect the prefixed tool itself', () => {
    expect(redirectTwin('pi_web_ask_user_question', tools)).toBeNull();
  });

  it('does not redirect tools without a registered twin', () => {
    expect(redirectTwin('bash', tools)).toBeNull();
  });

  it('tolerates non-string input', () => {
    expect(redirectTwin(undefined, tools)).toBeNull();
  });
});
