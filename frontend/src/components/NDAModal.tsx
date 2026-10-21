import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';

interface NDAModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<void>;
  isAccepting: boolean;
  ndaUrl: string | null;
}

export default function NDAModal({ isOpen, onClose, onAccept, isAccepting, ndaUrl }: NDAModalProps) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { setAccepted(false); }, [isOpen, ndaUrl]);
  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <div className="fixed inset-0 bg-black/50" />
        <div className="fixed inset-0 overflow-y-auto flex items-center justify-center p-4">
          <Dialog.Panel className="relative w-full max-w-3xl bg-white rounded-lg shadow-xl p-6">
            <Dialog.Title className="text-xl font-semibold mb-4">Non-Disclosure Agreement</Dialog.Title>
            {ndaUrl ? (
              <>
                <a href={ndaUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">Open the agreement in a new tab</a>
                <iframe src={ndaUrl} title="Approved Non-Disclosure Agreement" className="w-full h-96 border rounded mt-4" sandbox="" referrerPolicy="no-referrer" />
                <label className="flex gap-3 items-start my-4 text-sm text-gray-700">
                  <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={isAccepting} />
                  I have read and accept this agreement and am authorized to accept it for my organization.
                </label>
              </>
            ) : <p>The agreement is currently unavailable. Please contact support.</p>}
            <div className="flex justify-end gap-3 mt-4">
              <button type="button" onClick={onClose} disabled={isAccepting} className="px-4 py-2 border rounded">Cancel</button>
              <button type="button" onClick={onAccept} disabled={isAccepting || !accepted || !ndaUrl} className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
                {isAccepting ? 'Processing...' : 'Accept & Download'}
              </button>
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
