import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MkBreakpointService } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkBreadcrumb, MkBreadcrumbItem, MkDrawer, MkMenu, MkMenuItem, MkMenuTrigger, MkSplitter } from '@mk-kit/ui/navigation';
import { MkContextMenuTrigger } from '@mk-kit/ui/context-menu';
import { MkTable, type MkSortChange, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkSwitch } from '@mk-kit/ui/forms';
import { MkEmptyState } from '@mk-kit/ui/status';
import { MkSkeleton } from '@mk-kit/ui/data';
import { MkDialogService, MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import { MkLightboxService } from '@mk-kit/ui/media';
import { MkInput } from '@mk-kit/ui/forms';
import { MkDrag, MkDropZone, type MkDropZoneEvent } from '@mk-kit/ui/dnd';
import { MkHotkeysService } from '@mk-kit/ui/directives';
import type { Entry, Listing, SearchHit, SearchResult } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { DriveService } from '../core/drive.service';
import { OpsService } from '../core/ops.service';
import { UploaderService, filesFromDataTransfer } from '../core/uploader.service';
import { ago, bytes, dateTime } from '../core/format';
import { iconFor, kindOf } from '../core/file-kind';
import { FolderTree } from '../shared/folder-tree';
import { Preview } from '../shared/preview';
import { ShareDialog, type ShareDialogData } from '../shared/share-dialog';
import { FolderDetailsDialog, type FolderDetailsData } from '../shared/folder-details-dialog';

/**
 * One row per entry. The sortable column keys (`name`, `size`, `modified`)
 * are deliberately NOT properties of the row, so mk-table's own sort is a
 * no-op and `rows()` arrives already ordered. The ordering lives here rather
 * than in `MkTableColumn.compare` because the grid view shares it and because
 * the table negates a custom comparator for descending order, which would put
 * folders last.
 */
interface Row {
  id: string;
  entry: SearchHit;
}

type SortKey = 'name' | 'size' | 'modified';

const HIDDEN_KEY = 'mk-drive.showHidden';

@Component({
  selector: 'app-browse',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, MkInput, MkButton, MkIcon, MkBreadcrumb, MkBreadcrumbItem, MkDrawer, MkSplitter, MkMenu, MkMenuItem, MkMenuTrigger, MkContextMenuTrigger, MkTable, MkTableCell, MkSwitch, MkEmptyState, MkSkeleton, MkTooltip, MkDrag, MkDropZone, FolderTree, Preview],
  template: `
    <div class="browse" (dragenter)="onDragEnter($event)" (dragover)="onDragOver($event)" (dragleave)="onDragLeave()" (drop)="onDrop($event)" [class.browse--dropping]="dropping()">
      <header class="bar">
        <mk-breadcrumb class="crumbs">
          @for (c of crumbs(); track c.path) {
            <mk-breadcrumb-item [href]="c.last ? undefined : '/d/' + encode(c.path)" (click)="c.last ? null : go($event, c.path)">
              <span class="crumb" mkDropZone [mkDropZoneData]="c.path" [mkDropZoneDisabled]="c.last || !canWrite()" (mkDropZoneDropped)="droppedInto($event)">
                @if ($first) {
                  <mk-icon [name]="locationIcon()" size="sm" />
                }
                {{ c.label }}
              </span>
            </mk-breadcrumb-item>
          }
        </mk-breadcrumb>
        <div class="bar__actions">
          @if (selected().length) {
            <span class="count muted">{{ selected().length }} selected</span>
            <button mkButton variant="ghost" size="sm" (click)="downloadSelected()" mkTooltip="Download"><mk-icon name="download" size="sm" /> <span class="lbl">Download</span></button>
            @if (selected().length === 1) {
              <button mkButton variant="ghost" size="sm" (click)="share(selected()[0].entry)" mkTooltip="Share a link, or with a person"><mk-icon name="link" size="sm" /> <span class="lbl">Share</span></button>
              <button mkButton variant="ghost" size="sm" (click)="toggleStar(selected()[0].entry)" [mkTooltip]="drive.isStarred(selected()[0].entry.path) ? 'Remove star' : 'Star'"><mk-icon [name]="drive.isStarred(selected()[0].entry.path) ? 'star' : 'star-off'" size="sm" /> <span class="lbl">{{ drive.isStarred(selected()[0].entry.path) ? 'Unstar' : 'Star' }}</span></button>
            }
            @if (canWrite()) {
              @if (selected().length === 1) {
                <button mkButton variant="ghost" size="sm" (click)="renameSelected()" mkTooltip="Rename (F2)"><mk-icon name="edit" size="sm" /> <span class="lbl">Rename</span></button>
              }
              <button mkButton variant="ghost" size="sm" (click)="transferSelected('move')"><mk-icon name="folder-open" size="sm" /> <span class="lbl">Move</span></button>
              <button mkButton variant="ghost" size="sm" (click)="transferSelected('copy')"><mk-icon name="copy" size="sm" /> <span class="lbl">Copy</span></button>
              <button mkButton variant="ghost" size="sm" tone="danger" (click)="deleteSelected()" mkTooltip="Delete (Del)"><mk-icon name="trash" size="sm" /> <span class="lbl">Delete</span></button>
            }
            <button mkButton variant="ghost" size="sm" iconOnly aria-label="Clear selection" (click)="selected.set([])"><mk-icon name="close" size="sm" /></button>
          } @else {
            <input mkInput type="search" class="search" [value]="query()" (input)="query.set($any($event.target).value)" placeholder="Search here…" aria-label="Search in this folder" size="sm" />
            <button mkButton variant="ghost" size="sm" iconOnly [attr.aria-label]="view() === 'grid' ? 'Show as list' : 'Show as grid'" [mkTooltip]="view() === 'grid' ? 'List' : 'Grid'" (click)="toggleView()"><mk-icon [name]="view() === 'grid' ? 'layout-list' : 'layout-grid'" size="sm" /></button>
            @if (canWrite()) {
              <button mkButton size="sm" [mkMenuTriggerFor]="uploadMenu"><mk-icon name="upload" size="sm" /> <span class="lbl">Upload</span></button>
              <mk-menu #uploadMenu>
                <mk-menu-item (action)="pickFiles(false)"><mk-icon name="file-plus" size="sm" /> Files</mk-menu-item>
                <mk-menu-item (action)="pickFiles(true)"><mk-icon name="folder-plus" size="sm" /> A folder</mk-menu-item>
              </mk-menu>
              <button mkButton variant="outline" size="sm" (click)="newFolder()"><mk-icon name="folder-plus" size="sm" /> <span class="lbl">New folder</span></button>
              @if (!sharedRoot()) {
                <button mkButton variant="ghost" size="sm" iconOnly aria-label="Trash" mkTooltip="Trash" (click)="openTrash()"><mk-icon name="trash" size="sm" /></button>
              }
            }
            <label class="toggle"><mk-switch [(checked)]="showHidden" size="sm" aria-label="Show hidden files" /> <span class="muted">hidden</span></label>
            <button mkButton variant="ghost" size="sm" iconOnly [loading]="loading()" aria-label="Refresh" mkTooltip="Refresh" (click)="reload()"><mk-icon name="refresh-cw" size="sm" /></button>
          }
        </div>
      </header>

      @if (wide()) {
        <mk-splitter class="panes" [position]="22" [min]="14" [max]="45">
          <app-folder-tree mkSplitterStart class="tree" [root]="treeRoot()" [current]="path()" [version]="treeVersion()" (navigate)="open($event)" />
          <div mkSplitterEnd class="list" [mkContextMenuTriggerFor]="rowMenu" (contextmenu)="onContextMenu($event)">
            <ng-container *ngTemplateOutlet="list" />
          </div>
        </mk-splitter>
      } @else {
        <div class="list" [mkContextMenuTriggerFor]="rowMenu" (contextmenu)="onContextMenu($event)">
          <ng-container *ngTemplateOutlet="list" />
        </div>
      }
      @if (dropping()) {
        <div class="dropveil" aria-hidden="true"><mk-icon name="upload" size="lg" /><span>Drop to upload into {{ crumbs().at(-1)?.label }}</span></div>
      }
    </div>

    <ng-template #list>
      @if (searching()) {
        <div class="results muted">
          <span>
            @if (results(); as r) {
              {{ r.entries.length }} result{{ r.entries.length === 1 ? '' : 's' }} for “{{ query() }}” {{ inFiles() ? 'inside files' : 'by name' }} in {{ crumbs().at(-1)?.label }}@if (r.truncated) { — stopped early, narrow the search}@if (inFiles() && r.scanned !== undefined) { · {{ r.scanned }} file{{ r.scanned === 1 ? '' : 's' }} read}
            } @else {
              Searching…
            }
          </span>
          <label class="toggle results__mode"><mk-switch [(checked)]="inFiles" size="sm" aria-label="Search inside files" /> <span>inside files<span class="lbl"> (text, PDF)</span></span></label>
        </div>
      }
      @if (error(); as err) {
        <mk-empty-state icon="circle-alert" title="Could not open this folder" [description]="err" />
      } @else if (!listing() && loading()) {
        <div class="skeleton"><mk-skeleton [lines]="8" /></div>
      } @else if (rows().length === 0) {
        @if (searching()) {
          <mk-empty-state icon="search-off" title="Nothing matches" description="Try a shorter word, or search from a folder higher up." />
        } @else {
          <mk-empty-state icon="folder-open" title="Empty folder" [description]="listing()?.hiddenOmitted ? 'Only hidden files here — switch on “hidden” to see them.' : canWrite() ? 'Drop files here, or use Upload.' : 'Nothing in here yet.'" />
        }
      } @else if (view() === 'grid') {
        <div class="grid" role="list">
          @for (row of rows(); track row.id) {
            <div class="card" role="listitem" [class.card--selected]="isSelected(row)" [attr.data-path]="row.entry.path" mkDropZone [mkDropZoneData]="row.entry.path" [mkDropZoneDisabled]="row.entry.kind !== 'dir' || !canWrite()" (mkDropZoneDropped)="droppedInto($event)">
              <button type="button" class="card__body" mkDrag [mkDragData]="row.entry.path" [mkDragDisabled]="!canWrite()" (click)="cardClick($event, row)" [attr.aria-label]="row.entry.name">
                <span class="card__media">
                  @if (row.entry.thumb) {
                    <img [src]="api.thumbUrl(row.entry.path, 320)" [alt]="" loading="lazy" decoding="async" (error)="$any($event.target).hidden = true" />
                  }
                  <mk-icon [name]="icon(row.entry)" size="lg" class="card__icon" [class.card__icon--dir]="row.entry.kind === 'dir'" />
                </span>
                <span class="card__name">{{ row.entry.name }}</span>
                @if (searching()) {
                  <span class="card__where muted">{{ parentOf(row.entry.path) }}</span>
                  @if (row.entry.snippet) {<span class="card__where snippet">{{ row.entry.snippet }}</span>}
                }
              </button>
              <label class="card__check" [class.card__check--on]="isSelected(row)"><input type="checkbox" [checked]="isSelected(row)" (change)="toggleSelect(row)" [attr.aria-label]="'Select ' + row.entry.name" /></label>
              @if (drive.isStarred(row.entry.path)) {
                <mk-icon name="star" size="sm" class="card__star" />
              }
            </div>
          }
        </div>
      } @else {
        <mk-table [columns]="columns" [data]="rows()" trackKey="id" density="compact" [stackAt]="560" [clickableRows]="true" [stickyHeader]="true" selectable [(selected)]="selected" (rowClick)="activate($event)" (sortChange)="sortChanged($event)">
          <ng-template mkTableCell="name" let-row="row">
            <span class="name" [class.name--hidden]="row.entry.hidden" [attr.data-path]="row.entry.path" mkDropZone [mkDropZoneData]="row.entry.path" [mkDropZoneDisabled]="row.entry.kind !== 'dir' || !canWrite()" (mkDropZoneDropped)="droppedInto($event)">
              <span class="name__drag" mkDrag [mkDragData]="row.entry.path" [mkDragDisabled]="!canWrite()">
                <mk-icon [name]="icon(row.entry)" size="sm" class="name__icon" [class.name__icon--dir]="row.entry.kind === 'dir'" />
                <span class="name__text">{{ row.entry.name }}@if (searching()) {<span class="muted name__where">{{ parentOf(row.entry.path) }}</span>}@if (row.entry.snippet) {<span class="name__where snippet">{{ row.entry.snippet }}</span>}</span>
                @if (drive.isStarred(row.entry.path)) {
                  <mk-icon name="star" size="sm" class="name__star" />
                }
              </span>
            </span>
          </ng-template>
          <ng-template mkTableCell="size" let-row="row">
            <span class="num muted">{{ row.entry.kind === 'dir' ? '—' : f.bytes(row.entry.size) }}</span>
          </ng-template>
          <ng-template mkTableCell="modified" let-row="row">
            <span class="nowrap muted" [mkTooltip]="f.dateTime(row.entry.mtime)">{{ f.ago(row.entry.mtime) }}</span>
          </ng-template>
          <ng-template mkTableCell="actions" let-row="row">
            @if (row.entry.kind === 'file') {
              <a mkButton variant="ghost" size="sm" iconOnly [href]="api.fileUrl(row.entry.path, true)" download aria-label="Download" (click)="$event.stopPropagation()"><mk-icon name="download" size="sm" /></a>
            }
          </ng-template>
        </mk-table>
      }
    </ng-template>

    <mk-menu #rowMenu>
      @if (ctxRow(); as row) {
        <mk-menu-item (action)="activate(row)"><mk-icon [name]="row.entry.kind === 'dir' ? 'folder-open' : 'eye'" size="sm" /> Open</mk-menu-item>
        <mk-menu-item (action)="downloadSelected()"><mk-icon name="download" size="sm" /> Download</mk-menu-item>
        <mk-menu-item (action)="share(row.entry)"><mk-icon name="link" size="sm" /> Share…</mk-menu-item>
        <mk-menu-item (action)="toggleStar(row.entry)"><mk-icon [name]="drive.isStarred(row.entry.path) ? 'star-off' : 'star'" size="sm" /> {{ drive.isStarred(row.entry.path) ? 'Remove star' : 'Star' }}</mk-menu-item>
        @if (row.entry.kind === 'dir') {
          <mk-menu-item (action)="details(row.entry)"><mk-icon name="info" size="sm" /> Details…</mk-menu-item>
        }
        @if (canWrite()) {
          <mk-menu-item (action)="renameSelected()"><mk-icon name="edit" size="sm" /> Rename</mk-menu-item>
          <mk-menu-item (action)="transferSelected('move')"><mk-icon name="folder-open" size="sm" /> Move to…</mk-menu-item>
          <mk-menu-item (action)="transferSelected('copy')"><mk-icon name="copy" size="sm" /> Copy to…</mk-menu-item>
          <mk-menu-item danger (action)="deleteSelected()"><mk-icon name="trash" size="sm" /> Delete</mk-menu-item>
        }
      } @else if (canWrite()) {
        <mk-menu-item (action)="newFolder()"><mk-icon name="folder-plus" size="sm" /> New folder</mk-menu-item>
        <mk-menu-item (action)="pickFiles(false)"><mk-icon name="upload" size="sm" /> Upload files</mk-menu-item>
        <mk-menu-item (action)="reload()"><mk-icon name="refresh-cw" size="sm" /> Refresh</mk-menu-item>
      } @else {
        <mk-menu-item (action)="reload()"><mk-icon name="refresh-cw" size="sm" /> Refresh</mk-menu-item>
      }
    </mk-menu>

    <input #fileInput type="file" multiple hidden (change)="picked($event, false)" />
    <input #folderInput type="file" webkitdirectory hidden (change)="picked($event, true)" />

    <mk-drawer [(open)]="previewOpen" side="end" size="min(56rem, 100vw)" [heading]="previewEntry()?.name ?? ''">
      @if (previewSiblings().length > 1) {
        <div class="drawer-nav">
          <button mkButton variant="ghost" size="sm" iconOnly aria-label="Previous file" mkTooltip="Previous (←)" [disabled]="previewIndex() <= 0" (click)="previewStep(-1)"><mk-icon name="chevron-left" size="sm" /></button>
          <span class="muted small">{{ previewIndex() + 1 }} of {{ previewSiblings().length }}</span>
          <button mkButton variant="ghost" size="sm" iconOnly aria-label="Next file" mkTooltip="Next (→)" [disabled]="previewIndex() >= previewSiblings().length - 1" (click)="previewStep(1)"><mk-icon name="chevron-right" size="sm" /></button>
        </div>
      }
      <app-preview [entry]="previewOpen() ? previewEntry() : null" (restored)="reload()" (saved)="previewEntry.set($event); reload()" />
    </mk-drawer>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .browse {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        position: relative;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        padding: var(--mk-space-2) var(--mk-space-4);
        border-bottom: 1px solid var(--mk-border-subtle);
        flex-wrap: wrap;
        min-height: 48px;
      }
      .drawer-nav {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        margin: 0 0 var(--mk-space-3);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .crumbs {
        flex: 1;
        min-width: 0;
      }
      .crumb {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-1);
        padding: 2px 6px;
        margin: -2px -6px;
        border-radius: var(--mk-radius-sm);
      }
      .crumb.mk-drop-zone--receiving {
        background: var(--mk-primary-subtle);
        color: var(--mk-primary-subtle-text);
      }
      .bar__actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-1);
        flex-wrap: wrap;
      }
      .count {
        font-size: var(--mk-font-size-sm);
        margin-right: var(--mk-space-2);
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-1);
        font-size: var(--mk-font-size-sm);
        cursor: pointer;
        margin-left: var(--mk-space-2);
      }
      .panes {
        flex: 1;
        min-height: 0;
      }
      .tree {
        height: 100%;
      }
      .list {
        height: 100%;
        overflow: hidden auto;
      }
      .skeleton {
        padding: var(--mk-space-4);
      }
      .name {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
        min-width: 0;
        padding: 2px 6px;
        margin: -2px -6px;
        border-radius: var(--mk-radius-sm);
      }
      .name.mk-drop-zone--receiving {
        background: var(--mk-primary-subtle);
        color: var(--mk-primary-subtle-text);
        outline: 1px dashed var(--mk-primary);
      }
      .name__drag {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
        min-width: 0;
      }
      .name__drag.mk-drag--dragging {
        opacity: 0.5;
      }
      .name__icon {
        color: var(--mk-text-muted);
        flex: none;
      }
      .name__icon--dir {
        color: var(--mk-primary);
      }
      .name__text {
        overflow-wrap: anywhere;
      }
      .name--hidden {
        opacity: 0.6;
      }
      .search {
        width: 180px;
        margin-right: var(--mk-space-1);
      }
      .results {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--mk-space-3);
        flex-wrap: wrap;
        margin: 0;
        padding: var(--mk-space-3) var(--mk-space-4) 0;
        font-size: var(--mk-font-size-sm);
      }
      .snippet {
        color: var(--mk-text);
        font-style: italic;
      }
      .name__where,
      .card__where {
        display: block;
        font-size: var(--mk-font-size-xs);
        overflow-wrap: anywhere;
      }
      .name__star,
      .card__star {
        color: var(--mk-warning);
        flex: none;
      }
      .card__star {
        position: absolute;
        left: 10px;
        bottom: 10px;
        pointer-events: none;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: var(--mk-space-3);
        padding: var(--mk-space-4);
      }
      .card {
        position: relative;
        border-radius: var(--mk-radius-lg);
        background: var(--mk-surface);
        border: 1px solid var(--mk-border-subtle);
        transition: border-color var(--mk-duration-fast) var(--mk-ease-standard);
      }
      .card:hover {
        border-color: var(--mk-border-strong);
      }
      .card--selected {
        border-color: var(--mk-primary);
        box-shadow: 0 0 0 1px var(--mk-primary);
      }
      .card.mk-drop-zone--receiving {
        outline: 2px dashed var(--mk-primary);
        outline-offset: 2px;
      }
      .card__body {
        display: flex;
        flex-direction: column;
        gap: var(--mk-space-2);
        width: 100%;
        padding: var(--mk-space-2);
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        border-radius: inherit;
        min-width: 0;
      }
      .card__body:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
        outline-offset: 2px;
      }
      .card__body.mk-drag--dragging {
        opacity: 0.5;
      }
      .card__media {
        position: relative;
        display: grid;
        place-items: center;
        aspect-ratio: 4 / 3;
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface-2);
        overflow: hidden;
      }
      .card__media img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        background: var(--mk-surface-2);
      }
      .card__media img[hidden] {
        display: none;
      }
      .card__icon {
        color: var(--mk-text-muted);
      }
      .card__icon--dir {
        color: var(--mk-primary);
      }
      .card__media img + .card__icon {
        visibility: hidden;
      }
      .card__media img[hidden] + .card__icon {
        visibility: visible;
      }
      .card__name {
        font-size: var(--mk-font-size-sm);
        line-height: 1.3;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        padding: 0 4px 4px;
      }
      .card__check {
        position: absolute;
        top: 10px;
        left: 10px;
        width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
        border-radius: var(--mk-radius-sm);
        background: color-mix(in srgb, var(--mk-surface) 85%, transparent);
        opacity: 0;
        transition: opacity var(--mk-duration-fast);
      }
      .card:hover .card__check,
      .card__check--on,
      .card__check:focus-within {
        opacity: 1;
      }
      .card__check input {
        margin: 0;
        accent-color: var(--mk-primary);
        width: 16px;
        height: 16px;
      }
      @media (max-width: 640px) {
        .lbl {
          display: none;
        }
        .search {
          width: 120px;
        }
        .grid {
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: var(--mk-space-2);
          padding: var(--mk-space-3);
        }
        .card__check {
          opacity: 1;
        }
      }
      .browse--dropping .list {
        outline: 2px dashed var(--mk-primary);
        outline-offset: -6px;
      }
      .dropveil {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: var(--mk-space-2);
        background: color-mix(in srgb, var(--mk-primary) 8%, transparent);
        color: var(--mk-primary);
        font-weight: 600;
        pointer-events: none;
      }
    `,
  ],
})
export class BrowsePage {
  protected readonly api = inject(ApiService);
  protected readonly drive = inject(DriveService);
  private readonly ops = inject(OpsService);
  private readonly uploader = inject(UploaderService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  private readonly hotkeys = inject(MkHotkeysService);
  private readonly lightbox = inject(MkLightboxService);
  private readonly destroy = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly bp = inject(MkBreakpointService);
  private readonly title = inject(Title);
  protected readonly f = { bytes, dateTime, ago };
  protected readonly icon = iconFor;
  protected readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  protected readonly folderInput = viewChild.required<ElementRef<HTMLInputElement>>('folderInput');

  /** Drive path from the URL: `/d/Docs/a/b` → `Docs/a/b`. */
  protected readonly path = toSignal(this.route.url.pipe(map((segs) => segs.map((s) => s.path).join('/'))), { initialValue: '' });
  protected readonly location = computed(() => this.path().split('/')[0] ?? '');
  /** Set when the user reaches this path only through a folder shared with them: the tree and the crumbs start there. */
  protected readonly sharedRoot = computed(() => this.drive.sharedRootOf(this.path()));
  protected readonly treeRoot = computed(() => this.sharedRoot()?.path ?? this.location());
  protected readonly locationIcon = computed(() => (this.sharedRoot() ? 'users' : (this.drive.location(this.location())?.icon ?? 'hard-drive')));
  protected readonly canWrite = computed(() => (this.sharedRoot() ? this.listing()?.access === 'write' : this.drive.location(this.location())?.access === 'write'));
  protected readonly wide = this.bp.up('md');

  protected readonly listing = signal<Listing | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showHidden = signal(readHidden());
  protected readonly sort = signal<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  protected readonly selected = signal<Row[]>([]);
  protected readonly ctxRow = signal<Row | null>(null);
  protected readonly previewEntry = signal<Entry | null>(null);
  protected readonly previewOpen = signal(false);
  /** The files of this listing that open in the drawer (images go to the lightbox), for ← / → inside it. */
  protected readonly previewSiblings = computed(() => this.rows().map((r) => r.entry).filter((e) => e.kind === 'file' && kindOf(e) !== 'image'));
  protected readonly previewIndex = computed(() => this.previewSiblings().findIndex((e) => e.path === this.previewEntry()?.path));
  protected readonly dropping = signal(false);
  protected readonly treeVersion = signal(0);
  protected readonly view = signal<'list' | 'grid'>(readView());
  protected readonly query = signal('');
  protected readonly results = signal<SearchResult | null>(null);
  /** Search inside text files and PDFs instead of by name. */
  protected readonly inFiles = signal(false);
  protected readonly searching = computed(() => this.query().trim().length > 0);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private dragDepth = 0;
  protected readonly columns: MkTableColumn<Row>[] = [
    { key: 'name', header: 'Name', sortable: true, stack: 'title' },
    { key: 'size', header: 'Size', sortable: true, align: 'end', width: '110px' },
    { key: 'modified', header: 'Modified', sortable: true, width: '170px' },
    { key: 'actions', header: '', width: '56px', align: 'end', stack: 'footer' },
  ];

  protected readonly crumbs = computed(() => {
    const parts = this.path().split('/').filter(Boolean);
    const skip = this.sharedRoot() ? this.sharedRoot()!.path.split('/').length - 1 : 0;
    return parts.slice(skip).map((label, i) => ({ label, path: parts.slice(0, skip + i + 1).join('/'), last: skip + i === parts.length - 1 }));
  });

  protected readonly rows = computed<Row[]>(() => {
    const l = this.searching() ? this.results() : this.listing();
    if (!l) return [];
    const { key, dir } = this.sort();
    const sign = dir === 'asc' ? 1 : -1;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const cmp = (a: Entry, b: Entry): number => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      if (key === 'size') return sign * (a.size - b.size) || collator.compare(a.name, b.name);
      if (key === 'modified') return sign * (a.mtime - b.mtime) || collator.compare(a.name, b.name);
      return sign * collator.compare(a.name, b.name);
    };
    return [...l.entries].sort(cmp).map((entry) => ({ id: entry.path, entry }));
  });

  constructor() {
    effect(() => {
      const path = this.path();
      const hidden = this.showHidden();
      untracked(() => {
        this.selected.set([]);
        void this.load(path, hidden);
      });
    });
    effect(() => localStorage.setItem(HIDDEN_KEY, this.showHidden() ? '1' : '0'));
    effect(() => localStorage.setItem(VIEW_KEY, this.view()));
    effect(() => {
      const q = this.query().trim();
      const path = this.path();
      const hidden = this.showHidden();
      const inFiles = this.inFiles();
      untracked(() => {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.results.set(null);
        this.selected.set([]);
        if (!q) return;
        this.searchTimer = setTimeout(() => void this.runSearch(path, q, hidden, inFiles), 300);
      });
    });
    // `?open=name` (from Recent / Starred): preview that file once the listing is in
    effect(() => {
      const l = this.listing();
      const name = untracked(() => this.route.snapshot.queryParamMap.get('open'));
      if (!l || !name) return;
      const entry = l.entries.find((e) => e.name === name);
      untracked(() => {
        if (entry) this.openFile(entry);
        void this.router.navigate([], { queryParams: {}, replaceUrl: true });
      });
    });
    effect(() => {
      const parts = this.path().split('/').filter(Boolean);
      this.title.setTitle(parts.length ? `${parts[parts.length - 1]} · mk-drive` : 'mk-drive');
    });
    this.uploader.onLanded = (dir) => {
      if (dir === this.path()) this.reload();
    };
    const keys: [string, () => void][] = [
      ['mod+a', () => this.selected.set(this.rows())],
      ['escape', () => (this.previewOpen() ? this.previewOpen.set(false) : this.searching() ? this.query.set('') : this.selected.set([]))],
      ['mod+shift+g', () => this.toggleView()],
      ['delete', () => void this.deleteSelected()],
      ['f2', () => void this.renameSelected()],
      ['backspace', () => this.up()],
      ['enter', () => this.selected().length === 1 && this.activate(this.selected()[0])],
      ['mod+shift+n', () => void this.newFolder()],
    ];
    // text fields are mk-kit's business; a dialog or a menu owns its keys itself
    const inOverlay = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest('[role="dialog"], [role="alertdialog"], mk-menu');
    const offs = keys.map(([combo, fn]) =>
      this.hotkeys.register(combo, (e) => {
        if (inOverlay(e)) return;
        e.preventDefault();
        fn();
      }),
    );
    // ← / → move between files while the preview drawer is open (the drawer is an overlay, so these skip the guard)
    for (const [combo, delta] of [['left', -1], ['right', 1]] as const) {
      offs.push(
        this.hotkeys.register(combo, (e) => {
          if (!this.previewOpen()) return;
          e.preventDefault();
          this.previewStep(delta);
        }),
      );
    }
    this.destroy.onDestroy(() => {
      offs.forEach((off) => off());
      this.uploader.onLanded = null;
    });
  }

  private async load(path: string, hidden: boolean): Promise<void> {
    if (!path) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const l = await this.api.ls(path, { hidden });
      if (this.path() !== path) return;
      this.listing.set(l);
    } catch (e) {
      this.error.set(errorMessage(e));
      this.listing.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  reload(): void {
    this.treeVersion.update((v) => v + 1);
    void this.load(this.path(), this.showHidden()).then(() => {
      const alive = new Set(this.rows().map((r) => r.id));
      this.selected.update((s) => s.filter((r) => alive.has(r.id)));
    });
  }

  sortChanged(s: MkSortChange): void {
    if (s.direction === 'none') this.sort.set({ key: 'name', dir: 'asc' });
    else if (s.key === 'name' || s.key === 'size' || s.key === 'modified') this.sort.set({ key: s.key, dir: s.direction });
  }

  activate(row: Row): void {
    if (row.entry.kind === 'dir') this.open(row.entry.path);
    else this.openFile(row.entry);
  }

  /** Images open in the lightbox with their siblings; everything else in the preview drawer. */
  openFile(entry: Entry): void {
    void this.api.touchRecent(entry.path).catch(() => {});
    if (kindOf(entry) === 'image') {
      const images = this.rows().map((r) => r.entry).filter((e) => kindOf(e) === 'image');
      const index = Math.max(0, images.findIndex((e) => e.path === entry.path));
      this.lightbox.open(
        images.map((e) => ({ src: this.api.fileUrl(e.path), alt: e.name, caption: e.name })),
        index,
      );
      return;
    }
    this.previewEntry.set(entry);
    this.previewOpen.set(true);
  }

  /** Show the previous or next file of the listing in the open drawer. */
  previewStep(delta: number): void {
    const list = this.previewSiblings();
    const next = list[this.previewIndex() + delta];
    if (!next) return;
    void this.api.touchRecent(next.path).catch(() => {});
    this.previewEntry.set(next);
  }

  toggleView(): void {
    this.view.update((v) => (v === 'grid' ? 'list' : 'grid'));
  }

  isSelected(row: Row): boolean {
    return this.selected().some((r) => r.id === row.id);
  }

  toggleSelect(row: Row): void {
    this.selected.update((s) => (s.some((r) => r.id === row.id) ? s.filter((r) => r.id !== row.id) : [...s, row]));
  }

  /** Grid card: plain click opens; Ctrl/Cmd or Shift click selects. */
  cardClick(ev: MouseEvent, row: Row): void {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      ev.preventDefault();
      this.toggleSelect(row);
      return;
    }
    if (this.selected().length) {
      this.toggleSelect(row);
      return;
    }
    this.activate(row);
  }

  parentOf(path: string): string {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path;
  }

  share(entry: Entry): void {
    this.dialog.open<ShareDialog, void, ShareDialogData>(ShareDialog, { data: { entry }, size: 'md' });
  }

  /** Size, counts, newest change and the largest files under a folder. */
  details(entry: Entry): void {
    this.dialog.open<FolderDetailsDialog, void, FolderDetailsData>(FolderDetailsDialog, { data: { entry, showHidden: this.showHidden() }, size: 'md' });
  }

  async toggleStar(entry: Entry): Promise<void> {
    try {
      const on = await this.drive.toggleStar(entry.path);
      this.toast.success(on ? `Starred “${entry.name}”` : `Removed the star from “${entry.name}”`);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  private async runSearch(path: string, q: string, hidden: boolean, inFiles: boolean): Promise<void> {
    try {
      const r = await this.api.search(path, q, hidden, inFiles);
      if (this.path() === path && this.query().trim() === q && this.inFiles() === inFiles) this.results.set(r);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  open(path: string): void {
    void this.router.navigateByUrl('/d/' + this.encode(path));
  }

  up(): void {
    const parts = this.path().split('/');
    if (parts.length > 1) this.open(parts.slice(0, -1).join('/'));
  }

  go(ev: Event, path: string): void {
    ev.preventDefault();
    this.open(path);
  }

  encode(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  openTrash(): void {
    void this.router.navigateByUrl('/trash/' + encodeURIComponent(this.location()));
  }

  // ---- context menu: right-click selects the row under the pointer (unless it is already part of the selection) ----
  onContextMenu(ev: MouseEvent): void {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-path]');
    const path = el?.dataset['path'];
    const row = path ? this.rows().find((r) => r.id === path) ?? null : null;
    this.ctxRow.set(row);
    if (row && !this.selected().some((r) => r.id === row.id)) this.selected.set([row]);
  }

  private selectedPaths(): string[] {
    return this.selected().map((r) => r.entry.path);
  }

  // ---- actions ----
  async newFolder(): Promise<void> {
    if (!this.canWrite()) return;
    const name = await this.dialog.prompt({ title: 'New folder', label: 'Name', placeholder: 'Untitled folder', confirmText: 'Create' });
    if (!name?.trim()) return;
    try {
      const r = await this.api.mkdir(this.path(), name.trim());
      this.toast.success(`Folder “${r.path.split('/').pop()}” created`);
      this.reload();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async renameSelected(): Promise<void> {
    const row = this.selected()[0];
    if (!row || this.selected().length !== 1 || !this.canWrite()) return;
    const name = await this.dialog.prompt({ title: `Rename “${row.entry.name}”`, label: 'New name', value: row.entry.name, confirmText: 'Rename' });
    if (!name?.trim() || name.trim() === row.entry.name) return;
    try {
      await this.api.renameEntry(row.entry.path, name.trim());
      this.reload();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  async deleteSelected(): Promise<void> {
    const paths = this.selectedPaths();
    if (!paths.length || !this.canWrite()) return;
    const n = paths.length;
    const label = n === 1 ? `“${this.selected()[0].entry.name}”` : `${n} items`;
    if (!(await this.dialog.confirm({ title: `Move ${label} to the trash?`, message: 'You can restore it from the trash for 30 days.', confirmText: 'Delete', tone: 'danger' }))) return;
    await this.ops.delete(paths, () => this.reload());
    this.reload();
  }

  async transferSelected(kind: 'move' | 'copy'): Promise<void> {
    const paths = this.selectedPaths();
    if (!paths.length) return;
    const to = await this.ops.pickFolder({ title: kind === 'move' ? 'Move to' : 'Copy to', confirmText: kind === 'move' ? 'Move here' : 'Copy here', start: this.path(), moving: kind === 'move' ? paths : undefined });
    if (!to) return;
    await this.ops.transfer(kind, paths, to);
    this.reload();
  }

  downloadSelected(): void {
    const sel = this.selected();
    if (!sel.length) return;
    const url = sel.length === 1 && sel[0].entry.kind === 'file' ? this.api.fileUrl(sel[0].entry.path, true) : this.api.zipUrl(sel.map((r) => r.entry.path));
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.click();
  }

  // ---- in-app drag and drop: rows onto folder rows or breadcrumbs ----
  async droppedInto(ev: MkDropZoneEvent<string, string>): Promise<void> {
    const target = ev.zone.mkDropZoneData();
    const dragged = ev.item.mkDragData();
    if (!target || !dragged || !this.canWrite()) return;
    const inSelection = this.selected().some((r) => r.id === dragged);
    const paths = inSelection ? this.selectedPaths() : [dragged];
    if (paths.some((p) => p === target || target.startsWith(p + '/') || p.slice(0, p.lastIndexOf('/')) === target)) return;
    await this.ops.transfer('move', paths, target);
    this.reload();
  }

  // ---- files from the desktop ----
  onDragEnter(ev: DragEvent): void {
    if (!this.canWrite() || !ev.dataTransfer?.types.includes('Files')) return;
    this.dragDepth++;
    this.dropping.set(true);
  }
  onDragOver(ev: DragEvent): void {
    if (!this.canWrite() || !ev.dataTransfer?.types.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }
  onDragLeave(): void {
    if (this.dragDepth > 0) this.dragDepth--;
    if (this.dragDepth === 0) this.dropping.set(false);
  }
  async onDrop(ev: DragEvent): Promise<void> {
    this.dragDepth = 0;
    this.dropping.set(false);
    if (!this.canWrite() || !ev.dataTransfer?.types.includes('Files')) return;
    ev.preventDefault();
    const files = await filesFromDataTransfer(ev.dataTransfer);
    await this.enqueue(files);
  }

  pickFiles(folder: boolean): void {
    (folder ? this.folderInput() : this.fileInput()).nativeElement.click();
  }

  async picked(ev: Event, folder: boolean): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const files = [...(input.files ?? [])].map((file) => ({ file, relativePath: folder ? (file as File & { webkitRelativePath: string }).webkitRelativePath || file.name : file.name }));
    input.value = '';
    await this.enqueue(files);
  }

  /** Create the folders a dropped tree needs, then queue every file under the right directory. */
  private async enqueue(files: { file: File; relativePath: string }[]): Promise<void> {
    if (!files.length) return;
    const base = this.path();
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.relativePath.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort()) {
      const parent = d.includes('/') ? `${base}/${d.slice(0, d.lastIndexOf('/'))}` : base;
      await this.api.mkdir(parent, d.split('/').pop()!, 'fail').catch((e) => {
        if (e?.status !== 409) this.toast.danger(errorMessage(e));
      });
    }
    if (dirs.size) this.reload();
    this.uploader.policy = 'rename';
    this.uploader.add(files.map((f) => ({ file: f.file, dir: f.relativePath.includes('/') ? `${base}/${f.relativePath.slice(0, f.relativePath.lastIndexOf('/'))}` : base, name: f.relativePath.split('/').pop()! })));
  }
}

const VIEW_KEY = 'mk-drive.view';

function readView(): 'list' | 'grid' {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'list' || v === 'grid') return v;
  } catch {
    /* no storage */
  }
  return window.matchMedia('(max-width: 640px)').matches ? 'grid' : 'list';
}

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}
