import { useCallback, useState } from 'react';

import { uploadAttachment } from './api';
import type { AttachmentRef } from './types';

/** Stage uploaded attachments until the next message is sent. */
export function usePendingAttachments() {
  const [pending, setPending] = useState<AttachmentRef[]>([]);

  const add = useCallback(async (file: File): Promise<AttachmentRef | null> => {
    try {
      const ref = await uploadAttachment(file);
      setPending((prev) => [...prev, ref]);
      return ref;
    } catch (e) {
      console.error('attachment upload failed', e);
      return null;
    }
  }, []);

  const remove = useCallback((id: string) => {
    setPending((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => setPending([]), []);

  return { pending, add, remove, clear };
}
