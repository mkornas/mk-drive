import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MkTree, type MkTreeNode } from '@mk-kit/ui/navigation';
import { ApiService } from '../core/api.service';

interface Node extends MkTreeNode {
  value: string;
  children?: Node[];
}

const PLACEHOLDER = (): Node => ({ label: '…', value: '', disabled: true });
/** A folder node; the placeholder child is what earns it a chevron until it is loaded, so a folder known to have no subfolders gets none. */
const folder = (label: string, value: string, hasDirs = true): Node => ({ label, value, iconName: 'folder', ...(hasDirs ? { children: [PLACEHOLDER()] } : {}) });

/** Lazily loaded directory tree under `root` (a location, or a folder shared with the user); keeps node objects stable so mk-tree keeps its expansion state. */
@Component({
  selector: 'app-folder-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkTree],
  template: `<mk-tree [nodes]="nodes()" selectable [selected]="current()" (selectionChange)="pick($event)" (nodeToggle)="toggled($event)" aria-label="Folders" />`,
  styles: [
    `
      :host {
        display: block;
        box-sizing: border-box;
        overflow: auto;
        padding: var(--mk-space-2);
      }
    `,
  ],
})
export class FolderTree {
  private readonly api = inject(ApiService);
  /** Drive path of the top node: the location name, or a deeper folder when that is all the user may see. */
  readonly root = input.required<string>();
  readonly current = input.required<string>();
  /** Bump to re-read the current folder (and its parent) after something changed. */
  readonly version = input(0);
  readonly navigate = output<string>();

  protected readonly nodes = signal<Node[]>([]);
  private readonly byPath = new Map<string, Node>();
  /** Folders whose children are loaded, or loading: `reveal` awaits a load already in flight instead of walking past it. */
  private readonly loaded = new Map<string, Promise<void>>();

  constructor() {
    effect(() => {
      const root = this.root();
      untracked(() => void this.reset(root));
    });
    effect(() => {
      const cur = this.current();
      untracked(() => void this.reveal(cur));
    });
    effect(() => {
      this.version();
      const cur = untracked(() => this.current());
      untracked(() => void this.refresh(cur));
    });
  }

  private async reset(path: string): Promise<void> {
    this.byPath.clear();
    this.loaded.clear();
    const shared = path.includes('/');
    const root: Node = { ...folder(path.split('/').pop() ?? path, path), iconName: shared ? 'users' : 'hard-drive', expanded: true };
    this.byPath.set(path, root);
    this.nodes.set([root]);
    await this.load(root);
    // the root can arrive after the current path did (the location resolves a beat later on a deep link): open the way to it now
    await this.reveal(untracked(() => this.current()));
  }

  private load(node: Node): Promise<void> {
    const pending = this.loaded.get(node.value);
    if (pending) return pending;
    const run = (async () => {
      try {
        const listing = await this.api.ls(node.value, { dirsOnly: true });
        node.children = listing.entries.map((e) => {
          const n = folder(e.name, e.path, e.hasDirs !== false);
          this.byPath.set(e.path, n);
          return n;
        });
      } catch {
        node.children = [];
        this.loaded.delete(node.value);
      }
      this.nodes.set([...this.nodes()]);
    })();
    this.loaded.set(node.value, run);
    return run;
  }

  /**
   * Make sure every ancestor of `path` is loaded and expanded. mk-tree reads a node's
   * `expanded` flag only for objects it has not seen in the previous `nodes` input, and it
   * walks that previous input by reference — so opening a folder that is already on screen
   * means rebuilding the chain from the root down to it with fresh objects, leaving the old
   * ones (and every sibling and child, which keep their identity and state) untouched.
   */
  private async reveal(path: string): Promise<void> {
    const parts = path.split('/');
    let deepest = '';
    let closed = false;
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      const node = this.byPath.get(ancestor);
      if (!node) break;
      await this.load(node);
      deepest = ancestor;
      if (!node.expanded) closed = true;
    }
    if (closed && deepest) this.reopen(deepest);
  }

  private reopen(path: string): void {
    const parts = path.split('/');
    let root: Node | null = null;
    let parent: Node | null = null;
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const node = this.byPath.get(p);
      if (!node) break;
      const fresh: Node = { ...node, expanded: true };
      this.byPath.set(p, fresh);
      if (parent) parent.children = (parent.children ?? []).map((c) => (c === node ? fresh : c));
      else root = fresh;
      parent = fresh;
    }
    if (root) this.nodes.set([root]);
  }

  /** Re-read `path` and its parent so renames, moves and new folders show up. */
  private async refresh(path: string): Promise<void> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
    for (const p of [parent, path]) {
      if (!p) continue;
      const node = this.byPath.get(p);
      if (!node || !this.loaded.has(p)) continue;
      const wasExpanded = node.expanded;
      const before = new Map((node.children ?? []).map((c) => [c.value, c]));
      this.loaded.delete(p);
      // drop descendants of this node from the index; load() re-adds the direct children
      for (const key of [...this.byPath.keys()]) if (key.startsWith(p + '/')) this.byPath.delete(key);
      const listing = await this.api.ls(p, { dirsOnly: true }).catch(() => null);
      if (!listing) continue;
      this.loaded.set(p, Promise.resolve());
      node.children = listing.entries.map((e) => {
        const old = before.get(e.path);
        const n: Node = old ?? folder(e.name, e.path, e.hasDirs !== false);
        // a folder that just got (or lost) its first subfolder changes shape: a chevron appears or goes
        if (old && !this.loaded.has(old.value)) {
          if (e.hasDirs === false) delete n.children;
          else if (!n.children) n.children = [PLACEHOLDER()];
        }
        this.byPath.set(e.path, n);
        if (old?.children) for (const c of old.children) if (c.value) this.byPath.set(c.value, c);
        return n;
      });
      node.expanded = wasExpanded;
      this.nodes.set([...this.nodes()]);
    }
  }

  pick(value: unknown): void {
    if (typeof value === 'string' && value && value !== this.current()) this.navigate.emit(value);
  }

  toggled(node: MkTreeNode): void {
    void this.load(node as Node);
  }
}
