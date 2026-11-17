import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup } from '@testing-library/svelte';
import ImageModal from './ImageModal.svelte';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

// The component installs document-level delegated listeners, so the "zoomable"
// images live outside the component (as they do in the real transcript/composer).
function addImage(className, srcValue, altValue = '') {
  const img = document.createElement('img');
  img.className = className;
  img.src = srcValue;
  if (altValue) img.alt = altValue;
  document.body.appendChild(img);
  return img;
}

describe('ImageModal', () => {
  it('opens on a transcript image click and closes on overlay click', async () => {
    render(ImageModal);
    const trigger = addImage('message-image', 'data:image/png;base64,AAA', 'shot');
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('modal-image');

    trigger.click();
    await tick();
    expect(modal.classList.contains('open')).toBe(true);
    expect(modalImg.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(modalImg.alt).toBe('shot');

    modal.click(); // backdrop / overlay dismiss
    await tick();
    expect(modal.classList.contains('open')).toBe(false);
    expect(modalImg.hasAttribute('src')).toBe(false);

    trigger.remove();
  });

  it('opens for a composer image preview and closes on Escape', async () => {
    render(ImageModal);
    const trigger = addImage('pi-chat-attachment-preview', 'data:image/png;base64,BBB');
    const modal = document.getElementById('image-modal');

    trigger.click();
    await tick();
    expect(modal.classList.contains('open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(modal.classList.contains('open')).toBe(false);

    trigger.remove();
  });
});

it('enlarges Markdown images and SVG output previews with independent zoom controls', async () => {
  const { getByRole } = render(ImageModal);
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-content';
  wrapper.innerHTML =
    '<a href="/image.png"><img src="data:image/png;base64,CCC" alt="Markdown image"></a>';
  document.body.appendChild(wrapper);
  wrapper.querySelector('img').click();
  await tick();
  expect(document.querySelector('#image-modal').classList.contains('open')).toBe(true);
  getByRole('button', { name: 'Zoom in' }).click();
  await tick();
  expect(document.querySelector('#modal-image').style.width).toBe('150%');
  getByRole('button', { name: 'Close' }).click();
  await tick();
  window.dispatchEvent(
    new CustomEvent('pi:image-preview', {
      detail: { src: 'data:image/svg+xml,%3Csvg/%3E', alt: 'drawing.svg' },
    }),
  );
  await tick();
  expect(document.querySelector('#modal-image').alt).toBe('drawing.svg');
  expect(document.querySelector('#modal-image').style.width).toBe('100%');
  wrapper.remove();
});

it('closes on image letterboxing or blank space while a tap on the picture stays open', async () => {
  render(ImageModal);
  window.dispatchEvent(
    new CustomEvent('pi:image-preview', {
      detail: { src: 'data:image/png;base64,DDD', alt: 'Landscape' },
    }),
  );
  await tick();
  const modal = document.getElementById('image-modal'),
    img = document.getElementById('modal-image');
  Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 200, configurable: true });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 });
  img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 }));
  await tick();
  expect(modal.classList.contains('open')).toBe(true);
  img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 25 }));
  await tick();
  expect(modal.classList.contains('open')).toBe(false);
  window.dispatchEvent(
    new CustomEvent('pi:image-preview', { detail: { src: 'data:image/png;base64,DDD' } }),
  );
  await tick();
  document.querySelector('.image-viewport').click();
  await tick();
  expect(modal.classList.contains('open')).toBe(false);
});
