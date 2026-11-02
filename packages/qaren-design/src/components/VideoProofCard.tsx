import type { VideoProofCardProps } from '../types';
import { Play, cx } from './shared';
import { VerdictPill } from './VerdictPill';

export function VideoProofCard({
  verdict,
  title,
  duration,
  thumbnail,
  alt,
  meta,
  className,
}: VideoProofCardProps) {
  return (
    <figure className={cx('qr-video', className)} style={{ margin: 0 }}>
      <div className="qr-video__thumb">
        {thumbnail ? (
          <img src={thumbnail} alt={alt || 'Screen recording of the run'} />
        ) : (
          <div className="qr-video__ph">
            <span>Placeholder thumbnail</span>
          </div>
        )}
        <div className="qr-video__verdict">
          <VerdictPill verdict={verdict} size="sm" />
        </div>
        <span className="qr-video__play">
          <Play />
          {duration || 'm:ss'}
        </span>
      </div>
      <figcaption className="qr-video__body">
        <p className="qr-video__title">{title}</p>
        {meta ? <p className="qr-video__meta">{meta}</p> : null}
      </figcaption>
    </figure>
  );
}
