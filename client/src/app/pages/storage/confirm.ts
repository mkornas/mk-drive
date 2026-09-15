import type { MkDialogService } from '@mk-kit/ui/feedback';

/**
 * The typed confirmation every destructive Storage action needs: the agent
 * refuses without `confirm` equal to the name, so the dialog asks for exactly
 * that. Resolves with the name when it was typed right, null otherwise.
 */
export async function typedConfirm(
  dialog: MkDialogService,
  opts: { title: string; message: string; name: string; confirmText: string },
): Promise<string | null> {
  const typed = await dialog.prompt({
    title: opts.title,
    message: `${opts.message} Type ${opts.name} to confirm.`,
    label: 'Name',
    placeholder: opts.name,
    confirmText: opts.confirmText,
    required: true,
  });
  if (typed === null) return null;
  return typed.trim() === opts.name ? opts.name : '';
}

export const GIB = 1024 * 1024 * 1024;
