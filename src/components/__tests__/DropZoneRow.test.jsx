import { render, screen } from '@testing-library/react'
import DropZoneRow from '../DropZoneRow.jsx'

describe('DropZoneRow', () => {
  it('shows placeholders when names are missing', () => {
    render(
      <DropZoneRow
        leftName=""
        rightName=""
        onDropLeft={() => {}}
        onDropRight={() => {}}
        onSelectLeft={() => {}}
        onSelectRight={() => {}}
      />,
    )

    expect(
      screen.getAllByText('Drag and drop or click to select').length,
    ).toBe(2)
  })
})
