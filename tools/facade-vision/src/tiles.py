"""Overlapping image windows for small repeated components."""


def image_windows(width, height, tile_size=0, overlap=0.2):
    if tile_size == 0:
        return [(0, 0, width, height)]
    if tile_size < 128 or not 0 <= overlap < 1:
        raise ValueError('tile size must be >=128 pixels and overlap in [0,1)')
    def starts(length):
        if length <= tile_size:
            return [0]
        values = list(range(0, length-tile_size+1, max(1, round(tile_size*(1-overlap)))))
        return sorted(set(values + [length-tile_size]))
    return [(x,y,min(tile_size,width-x),min(tile_size,height-y))
            for y in starts(height) for x in starts(width)]
