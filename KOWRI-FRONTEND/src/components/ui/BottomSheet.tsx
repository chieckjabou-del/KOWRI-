import { Drawer } from "vaul";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  snapPoints?: number[];
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }} shouldScaleBackground>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 z-50 max-h-[92dvh] flex flex-col rounded-t-3xl bg-white outline-none max-w-lg mx-auto">
          <div className="mx-auto mt-3 mb-1 w-12 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
          {title ? (
            <div className="px-5 pt-3 pb-1 flex-shrink-0">
              <h2 className="text-xl font-bold text-gray-900">{title}</h2>
            </div>
          ) : null}
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-2">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
