import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
export function Drawer({ title, children, onClose, returnFocusRef, nested = false }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    returnFocusRef?: RefObject<HTMLElement | null>;
    nested?: boolean;
}) { return <Dialog.Root open onOpenChange={v => !v && onClose()}><Dialog.Portal><Dialog.Overlay className={nested ? 'overlay overlay-nested' : 'overlay'}/><Dialog.Content className={nested ? 'drawer drawer-nested' : 'drawer'} onCloseAutoFocus={event => { if (returnFocusRef?.current) { event.preventDefault(); returnFocusRef.current.focus(); } }}><header><div><span className="eyebrow">OPERATIONS / INSPECT</span><Dialog.Title>{title}</Dialog.Title></div><Dialog.Close aria-label="Tutup" className="icon"><X size={20}/></Dialog.Close></header><Dialog.Description className="sr-only">Detail dan konfigurasi operasi</Dialog.Description>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>; }
