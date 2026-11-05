/**
 * Pagefold - Gallery & History Manager
 */

import { getAllCaptures, deleteCapture, clearAllCaptures, getStorageUsage } from '../utils/db.js';
import { formatFilename } from '../utils/storage.js';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 KB';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export class HistoryManager {
  constructor(options = {}) {
    this.options = options;
    this.grid = document.getElementById('history-grid');
    this.emptyState = document.getElementById('history-empty');
    this.statText = document.getElementById('history-storage-stat');
    this.searchInput = document.getElementById('history-search-input');
    this.btnClear = document.getElementById('btn-clear-history');

    this.allCaptures = [];
    this.initEvents();
  }

  initEvents() {
    this.searchInput?.addEventListener('input', () => {
      this.filterCaptures(this.searchInput.value.trim().toLowerCase());
    });

    this.btnClear?.addEventListener('click', async () => {
      if (confirm('Are you sure you want to delete ALL capture history? This action cannot be undone.')) {
        await clearAllCaptures();
        await this.refresh();
        if (typeof this.options.onClear === 'function') {
          this.options.onClear();
        }
      }
    });
  }

  async refresh() {
    this.allCaptures = await getAllCaptures(false); // fast metadata + thumbnails
    const usage = await getStorageUsage();

    if (this.statText) {
      this.statText.textContent = `${usage.count} captures • ${formatBytes(usage.bytes)}`;
    }

    this.renderList(this.allCaptures);
  }

  filterCaptures(query) {
    if (!query) {
      this.renderList(this.allCaptures);
      return;
    }

    const filtered = this.allCaptures.filter((item) => {
      const titleMatch = item.title && item.title.toLowerCase().includes(query);
      const urlMatch = item.url && item.url.toLowerCase().includes(query);
      return titleMatch || urlMatch;
    });

    this.renderList(filtered);
  }

  renderList(items) {
    if (!this.grid) return;
    this.grid.innerHTML = '';

    if (!items || items.length === 0) {
      if (this.emptyState) this.emptyState.classList.remove('hidden');
      return;
    }

    if (this.emptyState) this.emptyState.classList.add('hidden');

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'history-card';
      card.dataset.id = item.id;

      const thumbSrc = item.thumbnail || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      const dims = item.dimensions ? `${item.dimensions.width} × ${item.dimensions.height}` : '';
      const sizeStr = item.fileSize ? formatBytes(item.fileSize) : '';

      card.innerHTML = `
        <div class="history-thumb-wrap" data-action="load" title="Open screenshot">
          <img src="${thumbSrc}" alt="Thumbnail" class="history-thumb" loading="lazy">
        </div>
        <div class="history-info">
          <div class="history-title" title="${item.title || 'Screenshot'}">${item.title || 'Screenshot'}</div>
          <div class="history-date">${formatDate(item.timestamp)} • ${dims}</div>
        </div>
        <div class="history-actions">
          <button class="btn-card-action" data-action="open">Open</button>
          <button class="btn-card-action danger" data-action="delete">Delete</button>
        </div>
      `;

      card.querySelector('[data-action="load"]')?.addEventListener('click', () => {
        if (typeof this.options.onSelect === 'function') {
          this.options.onSelect(item.id);
        }
      });

      card.querySelector('[data-action="open"]')?.addEventListener('click', () => {
        if (typeof this.options.onSelect === 'function') {
          this.options.onSelect(item.id);
        }
      });

      card.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete screenshot "${item.title || 'Screenshot'}"?`)) {
          await deleteCapture(item.id);
          await this.refresh();
          if (typeof this.options.onDelete === 'function') {
            this.options.onDelete(item.id);
          }
        }
      });

      this.grid.appendChild(card);
    }
  }
}
