import React from 'react';
import { ComposedModal, ModalHeader, ModalBody } from '@carbon/react';

/**
 * App modal, backed by Carbon's <ComposedModal>. Callers render their own
 * footer buttons inside `children`, so the body is a plain container.
 */
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
}

// Carbon sizes: xs (≈320) sm (≈480) md (≈768) lg (≈1024)
const SIZE: Record<NonNullable<ModalProps['size']>, 'xs' | 'sm' | 'md' | 'lg'> = {
  sm: 'xs', md: 'sm', lg: 'sm', xl: 'md', '2xl': 'md', '3xl': 'lg', '4xl': 'lg',
};

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = 'md' }) => (
  <ComposedModal open={isOpen} onClose={() => { onClose(); return false; }} size={SIZE[size]} preventCloseOnClickOutside={false}>
    <ModalHeader title={title} closeModal={onClose} />
    <ModalBody className="app-modal__body">{isOpen ? children : null}</ModalBody>
  </ComposedModal>
);
