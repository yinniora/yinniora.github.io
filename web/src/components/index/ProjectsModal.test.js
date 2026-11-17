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
it('confirms folder and child-file deletion twice without a text input', async () => {
  const onDelete = vi.fn().mockResolvedValue(true);
  const { getByRole, getByLabelText, container } = render(ProjectsModal, {
    props: { open: true, projects: [project], onDelete },
  });
  await fireEvent.click(getByRole('button', { name: 'Delete project demo' }));
  await fireEvent.click(getByLabelText('Also delete the project files'));
  expect(container.querySelector('#project-delete-name')).toBeNull();
  await fireEvent.click(getByRole('button', { name: 'Delete project', exact: true }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(getByRole('heading', { name: 'Delete the folder and all its files?' })).toBeTruthy();
  await fireEvent.click(getByRole('button', { name: 'Confirm folder deletion' }));
  expect(onDelete).toHaveBeenCalledWith('/work/demo', { deleteFiles: true, confirmation: 'demo' });
});
it('can cancel the second confirmation without deleting anything', async () => {
  const onDelete = vi.fn();
  const { getByRole, getByLabelText } = render(ProjectsModal, {
    props: { open: true, projects: [project], onDelete },
  });
  await fireEvent.click(getByRole('button', { name: 'Delete project demo' }));
  await fireEvent.click(getByLabelText('Also delete the project files'));
  await fireEvent.click(getByRole('button', { name: 'Delete project', exact: true }));
  await fireEvent.click(getByRole('button', { name: 'Cancel' }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(getByLabelText('Also delete the project files')).toBeTruthy();
});
