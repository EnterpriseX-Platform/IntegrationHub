import React from 'react';
import { Button as CdsButton, InlineLoading } from '@carbon/react';

/**
 * App button, backed by Carbon's <Button>. Keeps the app's props so existing
 * call sites do not change: variant/size/isLoading/leftIcon/rightIcon/fullWidth.
 */
interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

// Carbon names: sm 32px, md 40px, lg 48px. The app's "md" was 36px, closest is md.
const SIZE: Record<NonNullable<ButtonProps['size']>, 'sm' | 'md' | 'lg'> = { sm: 'sm', md: 'md', lg: 'lg' };

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  isLoading = false,
  leftIcon,
  rightIcon,
  fullWidth = false,
  className = '',
  disabled,
  type = 'button',
  ...props
}) => {
  const kind = variant === 'secondary' ? 'tertiary' : variant;
  return (
    <CdsButton
      kind={kind as any}
      size={SIZE[size]}
      type={type}
      disabled={disabled || isLoading}
      className={`app-btn ${fullWidth ? 'app-btn--full' : ''} ${className}`}
      {...(props as any)}
    >
      {isLoading ? (
        <InlineLoading className="app-btn__loading" description={typeof children === 'string' ? children : undefined} />
      ) : (
        <>
          {leftIcon && <span className="app-btn__icon">{leftIcon}</span>}
          {children}
          {rightIcon && <span className="app-btn__icon">{rightIcon}</span>}
        </>
      )}
    </CdsButton>
  );
};
