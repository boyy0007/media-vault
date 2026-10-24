<#
  QR codes for phones: "Connect a phone" in the status window (MediaVault.ps1) and on setup's last page (Setup.ps1).
  Dot-source it after loading System.Windows.Forms and mv-look.ps1. A phone's camera reads the code and opens the
  address, so nobody types https://{pc}.{tailnet}.ts.net:8443 on a phone keyboard.

  The encoder is a small one of our own (byte mode, error correction level M, versions 1-40, the mask with the
  lowest penalty), compiled by the .NET Framework that comes with Windows - no download or extra program. The web
  app has the same one in JavaScript (pb_public/qr.js, Sites > QR code); keep the two in step - they make identical
  codes.
#>

if (-not ('MvQr' -as [type])) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;

public static class MvQr {
  // Level M, by version (index 0 unused).
  static readonly int[] EccPerBlock = { -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28 };
  static readonly int[] Blocks = { -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49 };

  // The code as rows of modules (true = dark).
  public static bool[,] Encode(string text) {
    byte[] data = Encoding.UTF8.GetBytes(text);
    int ver = 1, capacity = 0;
    for (; ver <= 40; ver++) {
      capacity = DataCodewords(ver) * 8;
      if (4 + (ver < 10 ? 8 : 16) + data.Length * 8 <= capacity) break;
    }
    if (ver > 40) throw new ArgumentException("Too long for a QR code");

    var bits = new List<bool>();
    Action<int, int> put = (val, len) => { for (int i = len - 1; i >= 0; i--) bits.Add(((val >> i) & 1) != 0); };
    put(4, 4);                                   // byte mode
    put(data.Length, ver < 10 ? 8 : 16);
    foreach (byte b in data) put(b, 8);
    put(0, Math.Min(4, capacity - bits.Count));  // terminator
    put(0, (8 - bits.Count % 8) % 8);
    for (int pad = 0xEC; bits.Count < capacity; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var codewords = new byte[bits.Count / 8];
    for (int i = 0; i < bits.Count; i++) if (bits[i]) codewords[i >> 3] |= (byte)(1 << (7 - (i & 7)));

    int size = ver * 4 + 17;
    var m = new bool[size, size]; var fn = new bool[size, size];
    DrawFunctions(m, fn, ver, size);
    DrawData(m, fn, Interleave(codewords, ver), size);

    // The mask with the lowest penalty.
    int best = 0, bestScore = int.MaxValue;
    for (int mask = 0; mask < 8; mask++) {
      ApplyMask(m, fn, mask, size); DrawFormat(m, fn, mask, size);
      int score = Penalty(m, size);
      if (score < bestScore) { best = mask; bestScore = score; }
      ApplyMask(m, fn, mask, size); // (undo: masking is its own inverse)
    }
    ApplyMask(m, fn, best, size); DrawFormat(m, fn, best, size);
    return m;
  }

  // A picture of the code with the usual quiet zone (4 modules), each module $scale pixels.
  public static Bitmap Render(string text, int scale, Color dark, Color light) {
    bool[,] m = Encode(text);
    int size = m.GetLength(0), full = (size + 8) * scale;
    var bmp = new Bitmap(full, full);
    using (var g = Graphics.FromImage(bmp)) {
      g.Clear(light);
      using (var br = new SolidBrush(dark))
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++)
          if (m[y, x]) g.FillRectangle(br, (x + 4) * scale, (y + 4) * scale, scale, scale);
    }
    return bmp;
  }

  static int RawModules(int ver) {
    int r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { int n = ver / 7 + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  static int DataCodewords(int ver) { return RawModules(ver) / 8 - EccPerBlock[ver] * Blocks[ver]; }

  static void Set(bool[,] m, bool[,] fn, int x, int y, bool dark) { m[y, x] = dark; fn[y, x] = true; }

  static void DrawFunctions(bool[,] m, bool[,] fn, int ver, int size) {
    for (int i = 0; i < size; i++) { Set(m, fn, 6, i, i % 2 == 0); Set(m, fn, i, 6, i % 2 == 0); }
    foreach (var c in new[] { new[] { 3, 3 }, new[] { size - 4, 3 }, new[] { 3, size - 4 } })
      for (int dy = -4; dy <= 4; dy++) for (int dx = -4; dx <= 4; dx++) {
        int x = c[0] + dx, y = c[1] + dy, d = Math.Max(Math.Abs(dx), Math.Abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) Set(m, fn, x, y, d != 2 && d != 4);
      }
    int[] align = AlignmentPositions(ver, size);
    int last = align.Length - 1;
    for (int i = 0; i < align.Length; i++) for (int j = 0; j < align.Length; j++) {
      if ((i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0)) continue;
      for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++)
        Set(m, fn, align[i] + dx, align[j] + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
    }
    DrawFormat(m, fn, 0, size); // (reserves the area; drawn for real once the mask is chosen)
    if (ver >= 7) {
      int rem = ver;
      for (int i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
      int v = ver << 12 | rem;
      for (int i = 0; i < 18; i++) {
        bool b = ((v >> i) & 1) != 0; int a = size - 11 + i % 3, c = i / 3;
        Set(m, fn, a, c, b); Set(m, fn, c, a, b);
      }
    }
  }

  static int[] AlignmentPositions(int ver, int size) {
    if (ver == 1) return new int[0];
    int n = ver / 7 + 2, step = (ver * 8 + n * 3 + 5) / (n * 4 - 4) * 2;
    var r = new int[n]; r[0] = 6;
    for (int i = n - 1, pos = size - 7; i >= 1; i--, pos -= step) r[i] = pos;
    return r;
  }

  static void DrawFormat(bool[,] m, bool[,] fn, int mask, int size) {
    int data = (0 << 3) | mask; // level M = 0b00
    int rem = data;
    for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    int bits = (data << 10 | rem) ^ 0x5412;
    Func<int, bool> bit = i => ((bits >> i) & 1) != 0;
    for (int i = 0; i <= 5; i++) Set(m, fn, 8, i, bit(i));
    Set(m, fn, 8, 7, bit(6)); Set(m, fn, 8, 8, bit(7)); Set(m, fn, 7, 8, bit(8));
    for (int i = 9; i < 15; i++) Set(m, fn, 14 - i, 8, bit(i));
    for (int i = 0; i < 8; i++) Set(m, fn, size - 1 - i, 8, bit(i));
    for (int i = 8; i < 15; i++) Set(m, fn, 8, size - 15 + i, bit(i));
    Set(m, fn, 8, size - 8, true);
  }

  static byte Mul(int x, int y) {
    int z = 0;
    for (int i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >> 7) * 0x11D); z ^= ((y >> i) & 1) * x; }
    return (byte)z;
  }

  static byte[] Interleave(byte[] data, int ver) {
    int nb = Blocks[ver], ecc = EccPerBlock[ver], raw = RawModules(ver) / 8;
    int nShort = nb - raw % nb, shortLen = raw / nb;
    // Reed-Solomon generator for this many ECC codewords.
    var div = new byte[ecc]; div[ecc - 1] = 1; int root = 1;
    for (int i = 0; i < ecc; i++) {
      for (int j = 0; j < ecc; j++) { div[j] = Mul(div[j], root); if (j + 1 < ecc) div[j] ^= div[j + 1]; }
      root = Mul(root, 2);
    }
    var blocks = new List<byte[]>();
    for (int i = 0, k = 0; i < nb; i++) {
      int len = shortLen - ecc + (i < nShort ? 0 : 1);
      var block = new byte[shortLen + 1];
      Array.Copy(data, k, block, 0, len);
      var rem = new byte[ecc];
      for (int n = 0; n < len; n++) {
        int f = data[k + n] ^ rem[0];
        Array.Copy(rem, 1, rem, 0, ecc - 1); rem[ecc - 1] = 0;
        for (int j = 0; j < ecc; j++) rem[j] ^= Mul(div[j], f);
      }
      Array.Copy(rem, 0, block, shortLen + 1 - ecc, ecc);
      k += len; blocks.Add(block);
    }
    var result = new List<byte>();
    for (int i = 0; i <= shortLen; i++)
      for (int j = 0; j < nb; j++)
        if (i != shortLen - ecc || j >= nShort) result.Add(blocks[j][i]);
    return result.ToArray();
  }

  static void DrawData(bool[,] m, bool[,] fn, byte[] data, int size) {
    int i = 0;
    for (int right = size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (int vert = 0; vert < size; vert++)
        for (int j = 0; j < 2; j++) {
          int x = right - j;
          bool up = ((right + 1) & 2) == 0;
          int y = up ? size - 1 - vert : vert;
          if (!fn[y, x] && i < data.Length * 8) { m[y, x] = ((data[i >> 3] >> (7 - (i & 7))) & 1) != 0; i++; }
        }
    }
  }

  static void ApplyMask(bool[,] m, bool[,] fn, int mask, int size) {
    for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
      if (fn[y, x]) continue;
      bool inv;
      switch (mask) {
        case 0: inv = (x + y) % 2 == 0; break;
        case 1: inv = y % 2 == 0; break;
        case 2: inv = x % 3 == 0; break;
        case 3: inv = (x + y) % 3 == 0; break;
        case 4: inv = (x / 3 + y / 2) % 2 == 0; break;
        case 5: inv = x * y % 2 + x * y % 3 == 0; break;
        case 6: inv = (x * y % 2 + x * y % 3) % 2 == 0; break;
        default: inv = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
      }
      if (inv) m[y, x] = !m[y, x];
    }
  }

  // The standard's four penalty rules (runs, 2x2 blocks, finder-like patterns, dark/light balance).
  static int Penalty(bool[,] m, int size) {
    int score = 0, dark = 0;
    for (int pass = 0; pass < 2; pass++)
      for (int a = 0; a < size; a++) {
        int run = 0; bool prev = false;
        for (int b = 0; b < size; b++) {
          bool c = pass == 0 ? m[a, b] : m[b, a];
          if (b > 0 && c == prev) { run++; if (run == 5) score += 3; else if (run > 5) score++; }
          else run = 1;
          prev = c;
          if (b >= 10) {
            bool f1 = true, f2 = true;
            bool[] pat = { true, false, true, true, true, false, true, false, false, false, false };
            for (int k = 0; k < 11; k++) {
              bool v = pass == 0 ? m[a, b - 10 + k] : m[b - 10 + k, a];
              if (v != pat[k]) f1 = false;
              if (v != pat[10 - k]) f2 = false;
            }
            if (f1) score += 40; if (f2) score += 40;
          }
        }
      }
    for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
      if (m[y, x]) dark++;
      if (x < size - 1 && y < size - 1) { bool c = m[y, x]; if (c == m[y, x + 1] && c == m[y + 1, x] && c == m[y + 1, x + 1]) score += 3; }
    }
    int total = size * size;
    int off = (Math.Abs(dark * 20 - total * 10) + total - 1) / total - 1; // 10 points per 5% away from half dark
    if (off > 0) score += off * 10;
    return score;
  }
}
'@
}

# Where a phone can open Media Vault from, best first: @{ Label; Url; Note }. $https = the tailnet https address
# ('' if there's none), $tsIp = this PC's Tailscale IP, $lan = its home-network IPs.
function Get-MvPhoneChoices([string]$https, [string]$tsIp, $lan, [int]$port, [bool]$apk) {
  $list = @()
  if ($https) { $list += @{ Label = 'Media Vault - anywhere (Tailscale)'; Url = $https; Note = 'The phone needs the Tailscale app on, signed in to the same account as this PC.' } }
  elseif ($tsIp) { $list += @{ Label = 'Media Vault - anywhere (Tailscale)'; Url = "http://${tsIp}:$port/"; Note = 'The phone needs the Tailscale app on, signed in to the same account as this PC.' } }
  foreach ($ip in @($lan)) { if ($ip) { $list += @{ Label = "Media Vault - home Wi-Fi ($ip)"; Url = "http://${ip}:$port/"; Note = 'Works when the phone is on the same Wi-Fi as this PC.' } } }
  if ($apk -and $list.Count) {
    $base = $list[0].Url.TrimEnd('/')
    $list += @{ Label = 'Android app - download'; Url = "$base/downloads/media-vault.apk"; Note = "Android only. After installing, open the app and enter this address: $base" }
  }
  $list
}

# The "Connect a phone" window: pick an address, scan the code with the phone's camera.
function Show-MvPhoneQr($owner, $choices) {
  $choices = @($choices)
  if (-not $choices.Count) {
    [Windows.Forms.MessageBox]::Show("There's no address a phone can use yet: this PC isn't on a network (Wi-Fi or Tailscale). Connect it, then try again.", 'Media Vault', 'OK', 'Information') | Out-Null
    return
  }
  $dlg = New-Object Windows.Forms.Form; $dlg.Text = 'Connect a phone'; $dlg.Font = $Font; $dlg.ForeColor = $Ink; $dlg.BackColor = [Drawing.Color]::White
  $dlg.FormBorderStyle = 'FixedDialog'; $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false; $dlg.StartPosition = 'CenterParent'; $dlg.ShowInTaskbar = $false
  $dlg.AutoSize = $true; $dlg.AutoSizeMode = 'GrowAndShrink'
  $f = New-Object Windows.Forms.FlowLayoutPanel; $f.FlowDirection = 'TopDown'; $f.AutoSize = $true; $f.WrapContents = $false; $f.Padding = New-Object Windows.Forms.Padding(20, 16, 20, 14)
  $dlg.Controls.Add($f)
  $intro = New-Object Windows.Forms.Label; $intro.AutoSize = $true; $intro.MaximumSize = New-Object Drawing.Size(340, 0)
  $intro.Text = "Open the phone's camera, point it at the code and tap the link that appears."
  $pick = New-Object Windows.Forms.ComboBox; $pick.DropDownStyle = 'DropDownList'; $pick.Width = 340; $pick.Margin = New-Object Windows.Forms.Padding(0, 10, 0, 6)
  foreach ($c in $choices) { [void]$pick.Items.Add($c.Label) }
  $pic = New-Object Windows.Forms.PictureBox; $pic.Size = New-Object Drawing.Size(340, 340); $pic.SizeMode = 'Zoom'; $pic.BackColor = [Drawing.Color]::White
  $url = New-Object Windows.Forms.TextBox; $url.ReadOnly = $true; $url.Width = 340; $url.BorderStyle = 'None'; $url.BackColor = [Drawing.Color]::White; $url.TextAlign = 'Center'
  $url.Margin = New-Object Windows.Forms.Padding(0, 6, 0, 2)
  $note = New-Object Windows.Forms.Label; $note.AutoSize = $true; $note.MaximumSize = New-Object Drawing.Size(340, 0); $note.ForeColor = $Grey
  $close = New-Object Windows.Forms.Button; $close.Text = 'Close'; $close.DialogResult = 'OK'; $close.MinimumSize = New-Object Drawing.Size(88, 28)
  $close.Margin = New-Object Windows.Forms.Padding(252, 12, 0, 0)
  $f.Controls.AddRange(@($intro, $pick, $pic, $url, $note, $close))
  $dlg.AcceptButton = $close; $dlg.CancelButton = $close
  $pick.Add_SelectedIndexChanged({
    $c = $choices[$pick.SelectedIndex]
    if ($pic.Image) { $pic.Image.Dispose() }
    $pic.Image = [MvQr]::Render($c.Url, 8, [Drawing.Color]::Black, [Drawing.Color]::White) # (always dark on white: cameras need it)
    $url.Text = $c.Url; $note.Text = $c.Note
  })
  $pick.SelectedIndex = 0
  Set-ButtonLook $close 'primary'; Set-Looks $dlg
  [void]$dlg.ShowDialog($owner)
  if ($pic.Image) { $pic.Image.Dispose() }
}
