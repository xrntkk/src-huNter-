import React, { useState, useRef, useLayoutEffect, cloneElement } from 'react';

// --- Internal Types and Defaults ---

const DefaultHomeIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const DefaultCompassIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" /></svg>;
const DefaultBellIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;

export type NavItem = {
  id: string | number;
  icon: React.ReactElement<{ className?: string }>;
  label?: string;
  onClick?: () => void;
};

const defaultNavItems: NavItem[] = [
  { id: 'default-home', icon: <DefaultHomeIcon />, label: 'Home' },
  { id: 'default-explore', icon: <DefaultCompassIcon />, label: 'Explore' },
  { id: 'default-notifications', icon: <DefaultBellIcon />, label: 'Notifications' },
];

type LimelightNavProps = {
  items?: NavItem[];
  defaultActiveIndex?: number;
  /** Controlled active index. When provided, overrides internal click state. */
  activeIndex?: number;
  onTabChange?: (index: number) => void;
  /** Layout direction. Vertical drives the limelight along the left edge. */
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  limelightClassName?: string;
  iconContainerClassName?: string;
  iconClassName?: string;
};

/**
 * An adaptive navigation bar with a "limelight" effect that highlights the
 * active item. Supports horizontal (default) and vertical orientations.
 *
 * Colors map to this project's CSS variables (--accent / --bg-card /
 * --text-primary / --border) rather than shadcn's primary/card tokens.
 */
export const LimelightNav = ({
  items = defaultNavItems,
  defaultActiveIndex = 0,
  activeIndex: controlledIndex,
  onTabChange,
  orientation = 'horizontal',
  className = '',
  limelightClassName = '',
  iconContainerClassName = '',
  iconClassName = '',
}: LimelightNavProps) => {
  const [internalIndex, setInternalIndex] = useState(defaultActiveIndex);
  const activeIndex = controlledIndex ?? internalIndex;
  const [isReady, setIsReady] = useState(false);
  const navItemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const limelightRef = useRef<HTMLDivElement | null>(null);
  const isVertical = orientation === 'vertical';

  useLayoutEffect(() => {
    if (items.length === 0) return;

    const limelight = limelightRef.current;
    const activeItem = navItemRefs.current[activeIndex];

    if (limelight && activeItem) {
      if (isVertical) {
        const newTop = activeItem.offsetTop + activeItem.offsetHeight / 2 - limelight.offsetHeight / 2;
        limelight.style.top = `${newTop}px`;
      } else {
        const newLeft = activeItem.offsetLeft + activeItem.offsetWidth / 2 - limelight.offsetWidth / 2;
        limelight.style.left = `${newLeft}px`;
      }

      if (!isReady) {
        setTimeout(() => setIsReady(true), 50);
      }
    }
  }, [activeIndex, isReady, items, isVertical]);

  if (items.length === 0) {
    return null;
  }

  const handleItemClick = (index: number, itemOnClick?: () => void) => {
    setInternalIndex(index);
    onTabChange?.(index);
    itemOnClick?.();
  };

  return (
    <nav
      className={`relative inline-flex ${
        isVertical ? 'flex-col w-16 py-2' : 'items-center h-16 px-2'
      } rounded-lg bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border)] ${className}`}
    >
      {items.map(({ id, icon, label, onClick }, index) => (
        <a
          key={id}
          ref={el => { navItemRefs.current[index] = el }}
          className={`relative z-20 flex cursor-pointer items-center justify-center ${
            isVertical ? 'w-full p-3.5' : 'h-full p-5'
          } ${iconContainerClassName}`}
          onClick={() => handleItemClick(index, onClick)}
          aria-label={label}
        >
          {cloneElement(icon, {
            className: `w-6 h-6 transition-opacity duration-100 ease-in-out ${
              activeIndex === index ? 'opacity-100' : 'opacity-40'
            } ${icon.props.className || ''} ${iconClassName}`,
          })}
        </a>
      ))}

      {isVertical ? (
        <div
          ref={limelightRef}
          className={`absolute left-0 z-10 h-11 w-[5px] rounded-full bg-[var(--accent)] shadow-[50px_0_15px_var(--accent)] ${
            isReady ? 'transition-[top] duration-400 ease-in-out' : ''
          } ${limelightClassName}`}
          style={{ top: '-999px' }}
        >
          <div className="absolute top-[-30%] left-[5px] h-[160%] w-14 [clip-path:polygon(100%_5%,0_25%,0_75%,100%_95%)] bg-gradient-to-r from-[var(--accent)]/30 to-transparent pointer-events-none" />
        </div>
      ) : (
        <div
          ref={limelightRef}
          className={`absolute top-0 z-10 w-11 h-[5px] rounded-full bg-[var(--accent)] shadow-[0_50px_15px_var(--accent)] ${
            isReady ? 'transition-[left] duration-400 ease-in-out' : ''
          } ${limelightClassName}`}
          style={{ left: '-999px' }}
        >
          <div className="absolute left-[-30%] top-[5px] w-[160%] h-14 [clip-path:polygon(5%_100%,25%_0,75%_0,95%_100%)] bg-gradient-to-b from-[var(--accent)]/30 to-transparent pointer-events-none" />
        </div>
      )}
    </nav>
  );
};
