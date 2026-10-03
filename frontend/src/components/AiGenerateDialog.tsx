import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button, Field, Modal, Textarea } from '../ui'

/** 管理后台各处「AI 辅助生成」的需求描述弹窗 */
export default function AiGenerateDialog({
  open,
  title,
  example,
  label,
  placeholder,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  example: string
  label?: string
  placeholder?: string
  onConfirm: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const close = () => {
    setText('')
    onClose()
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            取消
          </Button>
          <Button
            icon={<Sparkles className="w-4 h-4" />}
            disabled={!text.trim()}
            onClick={() => {
              const v = text.trim()
              setText('')
              onConfirm(v)
            }}
          >
            生成
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-xs text-muted mb-1">示例：</p>
          <p className="text-xs text-fg-2 bg-surface-2 rounded-lg p-2 leading-relaxed">{example}</p>
        </div>
        <Field label={label}>
          <Textarea rows={5} value={text} autoFocus placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
