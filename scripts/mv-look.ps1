<#
  The look shared by the two windows, Setup.ps1 and MediaVault.ps1 (dot-source it after loading System.Windows.Forms
  and System.Drawing): colours, fonts, the app's mark, soft rounded cards and flat rounded buttons - drawn by hand,
  since WinForms' own can't round. Keep colours here, not in the windows.
#>

$Font = New-Object Drawing.Font('Segoe UI', 9.75)
$HeadFont = New-Object Drawing.Font('Segoe UI Semibold', 11)
$TitleFont = New-Object Drawing.Font('Segoe UI Semibold', 19)
$SmallBold = New-Object Drawing.Font('Segoe UI Semibold', 8.25)
$MonoFont = New-Object Drawing.Font($(if ((New-Object Drawing.Text.InstalledFontCollection).Families.Name -contains 'Cascadia Mono') { 'Cascadia Mono' } else { 'Consolas' }), 9)
# Icons: Windows 11's icon font, or Windows 10's (same code points for the ones used here).
$IconFont = New-Object Drawing.Font($(if ((New-Object Drawing.Text.InstalledFontCollection).Families.Name -contains 'Segoe Fluent Icons') { 'Segoe Fluent Icons' } else { 'Segoe MDL2 Assets' }), 11)
$Brand = [Drawing.Color]::FromArgb(109, 93, 252)
$BrandDark = [Drawing.Color]::FromArgb(87, 70, 232)
$Ink = [Drawing.Color]::FromArgb(17, 24, 39)
$Green = [Drawing.Color]::FromArgb(21, 128, 61)
$Amber = [Drawing.Color]::FromArgb(180, 83, 9)
$Red = [Drawing.Color]::FromArgb(185, 28, 28)
$Grey = [Drawing.Color]::FromArgb(107, 114, 128)
$Line = [Drawing.Color]::FromArgb(229, 231, 235)
$CardBg = [Drawing.Color]::FromArgb(248, 248, 252)
$SideBg = [Drawing.Color]::FromArgb(23, 21, 51)

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$rad) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath; $d = $rad * 2
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90); $p.CloseFigure(); $p
}
function Set-DoubleBuffered($c) { $c.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($c, $true, $null) }
# The colour actually behind a control (cards paint their own background).
function Get-SolidBack($c) { while ($c -and $c.BackColor.A -lt 255) { $c = $c.Parent }; if ($c) { $c.BackColor } else { [Drawing.Color]::White } }

# The app's mark: the brand circle with a white "play" triangle, $size across at ($x, $y).
function Draw-MvMark($g, [single]$x, [single]$y, [single]$size) {
  $g.FillEllipse((New-Object Drawing.SolidBrush $Brand), $x, $y, $size, $size)
  $k = $size / 34
  $g.FillPolygon([Drawing.Brushes]::White, [Drawing.PointF[]]@((New-Object Drawing.PointF ($x + 12.5 * $k), ($y + 9 * $k)),
    (New-Object Drawing.PointF ($x + 24 * $k), ($y + 17 * $k)), (New-Object Drawing.PointF ($x + 12.5 * $k), ($y + 25 * $k))))
}
# The window icon: the mark at 32x32.
function New-MvIcon {
  $bmp = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; Draw-MvMark $g 1 1 30; $g.Dispose()
  [Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# Flat rounded buttons: 'primary' = filled, 'secondary' = outlined.
function Set-ButtonLook($b, [string]$kind = 'secondary') {
  if ($b.Tag -is [hashtable] -and $b.Tag.Look) { $b.Tag.Kind = $kind; $b.Invalidate(); return }
  $b.Tag = @{ Look = $true; Kind = $kind; Hover = $false }
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0; $b.Cursor = 'Hand'; $b.UseVisualStyleBackColor = $false
  $b.Padding = New-Object Windows.Forms.Padding(12, 0, 12, 0)
  $b.MinimumSize = New-Object Drawing.Size([math]::Max(84, $b.MinimumSize.Width), 34)
  if ($b.Margin.Equals((New-Object Windows.Forms.Padding(3)))) { $b.Margin = New-Object Windows.Forms.Padding(0, 0, 8, 0) } # (lines up in a row)
  $b.Add_MouseEnter({ $this.Tag.Hover = $true; $this.Invalidate() })
  $b.Add_MouseLeave({ $this.Tag.Hover = $false; $this.Invalidate() })
  $b.Add_Paint({
    $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'
    $g.Clear((Get-SolidBack $this.Parent))
    $path = New-RoundRect 0.5 0.5 ($this.Width - 1.5) ($this.Height - 1.5) 7
    $on = $this.Enabled; $hover = $this.Tag.Hover -and $on
    if ($this.Tag.Kind -eq 'primary') {
      $fill = if (-not $on) { [Drawing.Color]::FromArgb(196, 189, 254) } elseif ($hover) { $BrandDark } else { $Brand }
      $g.FillPath((New-Object Drawing.SolidBrush $fill), $path); $fg = [Drawing.Color]::White
    } else {
      $g.FillPath((New-Object Drawing.SolidBrush $(if ($hover) { [Drawing.Color]::FromArgb(243, 244, 246) } else { [Drawing.Color]::White })), $path)
      $edge = if ($this.Focused -and $on) { $Brand } elseif ($hover) { [Drawing.Color]::FromArgb(209, 213, 219) } else { $Line }
      $g.DrawPath((New-Object Drawing.Pen $edge, $(if ($this.Focused -and $on) { 1.5 } else { 1 })), $path)
      $fg = if ($on) { $Ink } else { [Drawing.Color]::FromArgb(156, 163, 175) }
    }
    $path.Dispose()
    [Windows.Forms.TextRenderer]::DrawText($g, $this.Text, $this.Font, $this.ClientRectangle, $fg, [Windows.Forms.TextFormatFlags]'HorizontalCenter, VerticalCenter, SingleLine')
  })
  $b.Add_GotFocus({ $this.Invalidate() }); $b.Add_LostFocus({ $this.Invalidate() })
}
# Every button under $root that isn't styled yet gets the outlined look; one-line text boxes get a flat border.
function Set-Looks($root) {
  foreach ($c in $root.Controls) {
    if ($c -is [Windows.Forms.Button] -and -not ($c.Tag -is [hashtable] -and $c.Tag.Look)) { Set-ButtonLook $c }
    elseif ($c -is [Windows.Forms.TextBox] -and -not $c.Multiline) { $c.BorderStyle = 'FixedSingle' }
    Set-Looks $c
  }
}

# A soft rounded box (a top-to-bottom flow panel) to put rows of controls in.
function New-MvCard {
  $c = New-Object Windows.Forms.FlowLayoutPanel; $c.FlowDirection = 'TopDown'; $c.WrapContents = $false; $c.AutoSize = $true
  $c.BackColor = $CardBg; $c.Padding = New-Object Windows.Forms.Padding(18, 14, 18, 10); $c.Margin = New-Object Windows.Forms.Padding(0, 6, 0, 8)
  Set-DoubleBuffered $c
  $c.Add_Paint({
    $g = $_.Graphics; $g.SmoothingMode = 'AntiAlias'; $g.Clear((Get-SolidBack $this.Parent))
    $path = New-RoundRect 0.5 0.5 ($this.Width - 1.5) ($this.Height - 1.5) 10
    $g.FillPath((New-Object Drawing.SolidBrush $CardBg), $path); $g.DrawPath((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(234, 234, 242))), $path); $path.Dispose()
  })
  $c.Add_Resize({ $this.Invalidate() })
  $c
}
