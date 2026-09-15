import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The frame shared by the sign-in, set-up and protected-link pages: one card in the
 * middle of the page, the mark and the words centred, the form below. Bumblebee's
 * yellow is the stripe along the top and the primary button; everything else is the
 * preset's surfaces, so it follows light and dark.
 */
@Component({
  selector: 'app-auth-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <section class="card">
        <img class="mark" src="icon.svg" alt="" width="64" height="64" />
        <h1 class="title">{{ title() }}</h1>
        @if (lead()) {
          <p class="lead">{{ lead() }}</p>
        }
        <div class="body"><ng-content /></div>
      </section>
      <p class="foot muted">mk-drive · your files, where they already are</p>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100%;
      }
      .wrap {
        min-height: 100dvh;
        box-sizing: border-box;
        display: grid;
        grid-template-rows: 1fr auto;
        justify-items: center;
        align-items: center;
        gap: var(--mk-space-6);
        padding: var(--mk-space-6) var(--mk-space-4) var(--mk-space-5);
        background: var(--mk-bg);
      }
      .card {
        box-sizing: border-box;
        width: min(100%, 420px);
        padding: var(--mk-space-8) var(--mk-space-6) var(--mk-space-6);
        border-radius: var(--mk-radius-2xl);
        background: var(--mk-surface);
        border: 1px solid var(--mk-border-subtle);
        border-top: 4px solid var(--mk-primary);
        box-shadow: var(--mk-shadow-md);
        text-align: center;
      }
      .mark {
        display: block;
        width: 64px;
        height: 64px;
        margin: 0 auto var(--mk-space-5);
      }
      .title {
        font-size: var(--mk-font-size-3xl);
        line-height: 1.1;
        margin: 0 0 var(--mk-space-2);
        overflow-wrap: anywhere;
      }
      .lead {
        color: var(--mk-text-muted);
        margin: 0 auto;
        max-width: 34ch;
        line-height: var(--mk-line-height-relaxed);
      }
      .body {
        margin-top: var(--mk-space-6);
        text-align: left;
      }
      .foot {
        font-size: var(--mk-font-size-sm);
        margin: 0;
        text-align: center;
      }
      @media (max-width: 480px) {
        .wrap {
          padding: var(--mk-space-4) var(--mk-space-3) var(--mk-space-4);
        }
        .card {
          padding: var(--mk-space-6) var(--mk-space-4) var(--mk-space-5);
        }
      }
    `,
  ],
})
export class AuthCard {
  readonly title = input.required<string>();
  readonly lead = input('');
}
