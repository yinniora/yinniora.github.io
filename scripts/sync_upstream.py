#!/usr/bin/env python3
"""Fetch official changes or prepare an isolated YuGo Pi review worktree."""
from pathlib import Path
import argparse
import json
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def git(repo, *args, check=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=check,
                          capture_output=True, text=True)


def prepare(repo, upstream_ref, destination):
    if git(repo, 'status', '--porcelain').stdout.strip():
        raise ValueError('Commit or stash local changes before preparing a review.')
    before = git(repo, 'rev-parse', 'HEAD').stdout.strip()
    upstream = git(repo, 'rev-parse', '--verify', upstream_ref + '^{commit}').stdout.strip()
    if git(repo, 'merge-base', '--is-ancestor', upstream, 'main', check=False).returncode == 0:
        return {'status': 'up-to-date', 'mainHead': before, 'upstreamHead': upstream}
    if destination.exists():
        raise ValueError('Review destination already exists; it will not be overwritten.')
    branch = 'review/upstream-' + upstream[:12]
    git(repo, 'worktree', 'add', '-b', branch, str(destination), 'main')
    merge = git(destination, 'merge', '--no-ff', '--no-commit', '--no-edit', upstream, check=False)
    assert git(repo, 'rev-parse', 'HEAD').stdout.strip() == before
    conflicts = git(destination, 'diff', '--name-only', '--diff-filter=U').stdout.splitlines()
    if merge.returncode and not conflicts:
        raise RuntimeError('Merge stopped in the review worktree. Inspect git status there; main is unchanged.')
    return {'status': 'conflicts' if conflicts else 'review-required',
            'branch': branch, 'directory': str(destination), 'upstreamHead': upstream,
            'mainHead': before, 'conflicts': conflicts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'prepare'])
    args = parser.parse_args()
    config = json.loads((ROOT / 'variant.json').read_text())
    remote = git(ROOT, 'remote', 'get-url', 'upstream', check=False)
    if remote.returncode:
        git(ROOT, 'remote', 'add', 'upstream', config['upstream'] + '.git')
    elif remote.stdout.strip().removesuffix('.git') != config['upstream']:
        raise ValueError('The upstream remote differs from variant.json; review it before syncing.')
    git(ROOT, 'fetch', '--no-tags', 'upstream', config['upstreamBranch'])
    ref = 'upstream/' + config['upstreamBranch']
    if args.action == 'check':
        count = git(ROOT, 'rev-list', '--left-right', '--count', 'main...' + ref).stdout.strip()
        print('YuGo-only / upstream-only commits:', count)
        print('Fetched only. No working branch or running installation was changed.')
        return
    head = git(ROOT, 'rev-parse', ref).stdout.strip()
    destination = ROOT.parent / (ROOT.name + '-upstream-review-' + head[:12])
    result = prepare(ROOT, ref, destination)
    print(json.dumps(result, indent=2))
    print('Resolve conflicts in the review directory, review the diff, run make check, then open a PR to main.')
    print('No commit, push, installation or merge into main was performed.')
    if result['status'] == 'conflicts':
        raise SystemExit(2)


if __name__ == '__main__':
    main()
