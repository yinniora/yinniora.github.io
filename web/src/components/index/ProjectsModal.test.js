import { afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import ProjectsModal from './ProjectsModal.svelte';
afterEach(cleanup);
const project = {
  path: '/work/demo',
  source: 'discovered',
  enabled: true,
  sessionCount: 2,
  fileSessionCount: 3,
  canDeleteFiles: true,
};
it('offers deletion for discovered projects and keeps files by default', async () => {
  const onDelete = vi.fn().mockResolvedValue(true);
  const { getByRole, getByLabelText } = render(ProjectsModal, {
    props: { open: true, projects: [project], onDelete },
  });
  await fireEvent.click(getByRole('button', { name: 'Delete project demo' }));
  expect(getByLabelText('Also delete the project files').checked).toBe(false);
  await fireEvent.click(getByRole('button', { name: 'Delete project', exact: true }));
  expect(onDelete).toHaveBeenCalledWith('/work/demo', { deleteFiles: false, confirmation: '' });
});
it('requires the project name before deleting files and can cancel without mutation', async () => {
  const onDelete = vi.fn();
  const { getByRole, getByLabelText, container } = render(ProjectsModal, {
    props: { open: true, projects: [project], onDelete },
  });
  await fireEvent.click(getByRole('button', { name: 'Delete project demo' }));
  await fireEvent.click(getByLabelText('Also delete the project files'));
  const confirm = getByRole('button', { name: 'Delete project', exact: true });
  expect(confirm.disabled).toBe(true);
  await fireEvent.input(container.querySelector('#project-delete-name'), {
    target: { value: 'demo' },
  });
  expect(confirm.disabled).toBe(false);
  await fireEvent.click(getByRole('button', { name: 'Cancel' }));
  expect(onDelete).not.toHaveBeenCalled();
});
