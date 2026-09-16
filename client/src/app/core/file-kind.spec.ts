import { describe, expect, it } from 'vitest';
import { extensionOf, iconClass, iconFor, kindOf, previewable } from './file-kind';

const file = (name: string, mime = 'application/octet-stream') => ({ kind: 'file' as const, mime, name });

describe('what a file is', () => {
  it('believes the type when the server knows one', () => {
    expect(kindOf({ kind: 'dir', mime: '', name: 'Photos' })).toBe('dir');
    expect(kindOf(file('holiday.jpg', 'image/jpeg'))).toBe('image');
    expect(kindOf(file('clip.mkv', 'video/x-matroska'))).toBe('video');
    expect(kindOf(file('song.flac', 'audio/flac'))).toBe('audio');
    expect(kindOf(file('invoice.pdf', 'application/pdf'))).toBe('pdf');
    expect(kindOf(file('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe('doc');
    expect(kindOf(file('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).toBe('sheet');
    expect(kindOf(file('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'))).toBe('slides');
    expect(kindOf(file('book.epub', 'application/epub+zip'))).toBe('ebook');
  });

  it('falls back to the name, which is how most files actually arrive', () => {
    expect(kindOf(file('report.docx'))).toBe('doc');
    expect(kindOf(file('BUDGET.XLSX'))).toBe('sheet');
    expect(kindOf(file('numbers.csv'))).toBe('sheet');
    expect(kindOf(file('app.ts'))).toBe('code');
    expect(kindOf(file('main.rs'))).toBe('code');
    expect(kindOf(file('notes.md'))).toBe('markdown');
    expect(kindOf(file('package.json'))).toBe('json');
    expect(kindOf(file('ubuntu.iso'))).toBe('disk');
    expect(kindOf(file('mk-nas_0.9.0_amd64.deb'))).toBe('app');
    expect(kindOf(file('Inter.woff2'))).toBe('font');
    expect(kindOf(file('film.srt'))).toBe('subtitle');
    expect(kindOf(file('backup.sqlite'))).toBe('database');
    expect(kindOf(file('photos.tar.gz'))).toBe('archive');
  });

  it('gives up honestly', () => {
    expect(kindOf(file('unknown'))).toBe('other');
    expect(kindOf(file('.bashrc'))).toBe('other');
    expect(kindOf(file('archive.unknownext'))).toBe('other');
    expect(kindOf({ kind: 'file', mime: 'text/plain' })).toBe('text');
  });

  it('reads an extension the way people write file names', () => {
    expect(extensionOf('a.b.c.TXT')).toBe('txt');
    expect(extensionOf('noextension')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});

describe('how it looks', () => {
  it('has an icon for every kind, and the familiar one where there is one', () => {
    expect(iconFor({ kind: 'dir', mime: '', name: 'x' })).toBe('folder');
    expect(iconFor(file('budget.xlsx'))).toBe('file-spreadsheet');
    expect(iconFor(file('deck.pptx'))).toBe('presentation');
    expect(iconFor(file('main.go'))).toBe('file-code');
    expect(iconFor(file('book.epub'))).toBe('book');
    expect(iconFor(file('unknown'))).toBe('file');
  });

  it('colours only what people already read as colour, and keeps the caller’s own class', () => {
    expect(iconClass({ kind: 'dir', mime: '', name: 'x' }, 'card__icon')).toBe('card__icon ficon ficon--dir');
    expect(iconClass(file('invoice.pdf'))).toBe('ficon ficon--pdf');
    expect(iconClass(file('budget.xlsx'))).toBe('ficon ficon--sheet');
    // code is not a colour anybody knows
    expect(iconClass(file('main.rs'))).toBe('ficon');
    expect(iconClass(file('unknown'), 'row__icon')).toBe('row__icon ficon');
  });

  it('knows what the preview pane can show', () => {
    expect(previewable('image')).toBe(true);
    expect(previewable('code')).toBe(true);
    expect(previewable('subtitle')).toBe(true);
    expect(previewable('archive')).toBe(false);
    expect(previewable('doc')).toBe(false);
    expect(previewable('dir')).toBe(false);
  });
});
